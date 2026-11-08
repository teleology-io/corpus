/**
 * Slack connector for the web app: conversations, history, threads, sending and search for the
 * signed-in user's Slack connection. All Slack calls happen here (server side) with the user's
 * stored token; the browser only ever sees DTOs.
 *
 * Connect / disconnect go through the generic integration endpoints (token or OAuth), and
 * background sync is the worker's job — `startSync`/`stopSync` toggle it.
 */
import { error } from '@sveltejs/kit';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { db, schema } from '@corpus/db';
import {
	ProviderAuthError,
	SlackApiError,
	conversationKind,
	missingSlackScopes,
	parseMrkdwn,
	parseSlackLink,
	type SlackMessage
} from '@corpus/core/integrations';
import {
	cachedMessages,
	cachedThread,
	cachedUsers,
	changedMessages,
	clearSlackCache,
	conversationRow,
	conversationRows,
	conversationUnread,
	historyRestricted,
	loadOlder,
	markOpened,
	recheckWindow,
	resolveUsers,
	slackCtx,
	syncConversations,
	syncNew,
	syncThread,
	upsertMessages,
	userIds,
	type SlackConversationRow,
	type SlackCtx
} from '@corpus/db/slack';
import type {
	SlackConversationDTO,
	SlackIdentityDTO,
	SlackMessageDTO,
	SlackMessagesPage,
	SlackSearchResultDTO
} from '#lib/types.js';
import { requestPoll } from './integrations';
import {
	fromApi,
	messageDTO,
	requireSlack,
	slackCall,
	slackConnection,
	slackErrorMessage,
	slackUserId,
	type MessageLike
} from './slack';

const { integrationConnection: conn, slackThread } = schema;
type Conn = typeof conn.$inferSelect;

/** Every Nth poll of an open conversation re-reads the newest page to catch edits/deletes. */
const RECHECK_EVERY = 6;
const pollCounts = new Map<string, number>();
/** Identical requests in flight share one Slack round trip (no overlapping polls). */
const inflight = new Map<string, Promise<unknown>>();

function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const hit = inflight.get(key);
	if (hit) return hit as Promise<T>;
	const p = fn().finally(() => inflight.delete(key));
	inflight.set(key, p);
	return p;
}

const clip = (s: string, n = 280) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const num = (ts: string | null | undefined) => Number(ts ?? 0);

/** Run a sync step; rate limits and access errors degrade to "show the cache" instead of failing. */
async function soft(fn: () => Promise<unknown>) {
	try {
		await fn();
		return { retryAfterSec: null, error: null };
	} catch (e) {
		if (e instanceof ProviderAuthError) error(409, 'Slack needs to be reconnected');
		if (e instanceof SlackApiError)
			return {
				retryAfterSec: e.retryAfterSec ?? null,
				error: e.code === 'ratelimited' ? null : slackErrorMessage(e)
			};
		throw e;
	}
}

async function ctxFor(userId: string) {
	const c = await requireSlack(userId);
	return slackCall(() => slackCtx(c, 'interactive'));
}

/** Browser has a Slack view open: lets the worker keep its faster cadence. */
async function touchClient(c: Conn) {
	await db
		.update(conn)
		.set({
			cursor: dsql`${conn.cursor} || jsonb_build_object('clientActiveAt', ${String(Date.now())}::text)`
		})
		.where(eq(conn.id, c.id));
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

export async function identity(userId: string): Promise<SlackIdentityDTO | null> {
	const c = await slackConnection(userId);
	if (!c) return null;
	return {
		userId: c.cursor.userId ?? null,
		teamName: c.cursor.teamName ?? null,
		account: c.accountLogin,
		status: c.status,
		error: c.status === 'error' ? c.lastError : null,
		lastSyncedAt: c.lastPolledAt?.toISOString() ?? null,
		missingScopes: missingSlackScopes(c.scopes),
		restricted: await historyRestricted(c.id, c.settings.slackRateProfile ?? 'auto')
	};
}

// ---------------------------------------------------------------------------
// conversations
// ---------------------------------------------------------------------------

/** `mpdm-alice--bob--carol-1` → `alice, bob, carol` */
const mpimName = (name: string | null) =>
	name
		? name
				.replace(/^mpdm-/, '')
				.replace(/-\d+$/, '')
				.split('--')
				.join(', ')
		: 'Group DM';

function conversationDTO(
	r: SlackConversationRow,
	users: Record<string, { name: string; image: string | null }>
): SlackConversationDTO {
	const dm = r.kind === 'im' && r.dmUserId ? users[r.dmUserId] : null;
	return {
		id: r.channelId,
		kind: r.kind as SlackConversationDTO['kind'],
		name:
			r.kind === 'im'
				? (dm?.name ?? r.dmUserId ?? 'Direct message')
				: r.kind === 'mpim'
					? mpimName(r.name)
					: (r.name ?? r.channelId),
		topic: r.topic,
		image: dm?.image ?? null,
		unread: conversationUnread(r),
		latestAt: r.latestTs ? new Date(num(r.latestTs) * 1000).toISOString() : null,
		inaccessible: r.inaccessibleCode
	};
}

const KIND_ORDER = { public: 0, private: 0, mpim: 1, im: 1 } as const;

/** Sidebar list from the cache. First visit (empty cache) or `refresh` syncs from Slack. */
export async function listConversations(userId: string, refresh = false) {
	const c = await requireSlack(userId);
	let rows = await conversationRows(c.id);
	let warning: string | null = null;
	if (refresh || !rows.length) {
		const ctx = await slackCall(() => slackCtx(c, 'interactive'));
		const res = await soft(() => once(`list:${c.id}`, () => syncConversations(ctx)));
		warning = res.error;
		rows = await conversationRows(c.id);
	}
	const dmIds = rows.filter((r) => r.kind === 'im' && r.dmUserId).map((r) => r.dmUserId!);
	let users = await cachedUsers(c.id, dmIds);
	const missing = dmIds.filter((id) => !users[id]);
	if (missing.length) {
		// users.info is Tier 4; resolve names once, then they're cached for a day.
		try {
			const ctx = await slackCtx(c, 'interactive');
			users = { ...users, ...(await resolveUsers(ctx, missing)) };
		} catch (e) {
			if (e instanceof ProviderAuthError) error(409, 'Slack needs to be reconnected');
		}
	}
	const list = rows
		.filter((r) => !r.isArchived)
		.map((r) => conversationDTO(r, users))
		.sort(
			(a, b) =>
				KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
				(KIND_ORDER[a.kind] === 1
					? (b.latestAt ?? '').localeCompare(a.latestAt ?? '') || a.name.localeCompare(b.name)
					: a.name.localeCompare(b.name))
		);
	return { conversations: list, warning };
}

/** One cached conversation (also non-member ones opened from search/browse). */
export async function conversationById(userId: string, channelId: string) {
	const c = await slackConnection(userId);
	if (!c) return null;
	const row = await conversationRow(c.id, channelId);
	if (!row) return null;
	const users = row.dmUserId ? await cachedUsers(c.id, [row.dmUserId]) : {};
	return conversationDTO(row, users);
}

/** Channels the user can see but may not have joined (conversations.list). */
export async function browseConversations(userId: string, cursor?: string) {
	const ctx = await ctxFor(userId);
	const page = await slackCall(() => ctx.client.conversationsList({ cursor, limit: 200 }));
	return {
		channels: page.items
			.filter((c) => !c.is_archived)
			.map((c) => ({
				id: c.id,
				name: c.name ?? c.id,
				kind: conversationKind(c),
				isMember: !!c.is_member,
				members: c.num_members ?? null,
				topic: c.topic?.value || c.purpose?.value || null
			})),
		nextCursor: page.nextCursor
	};
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

async function toDTOs(
	ctx: SlackCtx,
	me: string | null,
	rows: MessageLike[]
): Promise<SlackMessageDTO[]> {
	const users = await resolveUsers(
		ctx,
		userIds(rows.map((r) => ({ user: r.userId, text: r.text })))
	);
	return rows.map((r) => messageDTO(r, users, me));
}

/**
 * Messages for the open conversation.
 *  - `since`: incremental poll — new messages after `since`, plus `changed` (edited/deleted
 *    since `changedSince`) among ones the client already shows.
 *  - `before`: one older page.
 *  - neither: the newest page.
 */
export async function getMessages(
	userId: string,
	channelId: string,
	opts: { since?: string; before?: string; changedSince?: string } = {}
): Promise<SlackMessagesPage> {
	const syncedAt = new Date();
	const c = await requireSlack(userId);
	const ctx = await slackCall(() => slackCtx(c, 'interactive'));
	const me = await slackUserId(c, ctx.client).catch(() => null);
	await touchClient(c);

	let status: { retryAfterSec: number | null; error: string | null } = {
		retryAfterSec: null,
		error: null
	};
	if (opts.before) {
		const have = await cachedMessages(c.id, channelId, { before: opts.before, limit: 50 });
		if (have.length < 50)
			status = await soft(() =>
				once(`older:${c.id}:${channelId}:${opts.before}`, () => loadOlder(ctx, channelId))
			);
	} else {
		const key = `${c.id}:${channelId}`;
		const n = (pollCounts.get(key) ?? 0) + 1;
		pollCounts.set(key, n);
		status = await soft(() =>
			once(`new:${key}`, async () => {
				await syncNew(ctx, channelId);
				if (!ctx.restricted && opts.since && n % RECHECK_EVERY === 0)
					await recheckWindow(ctx, channelId);
			})
		);
	}

	const rows = opts.before
		? await cachedMessages(c.id, channelId, { before: opts.before, limit: 50 })
		: await cachedMessages(c.id, channelId, { since: opts.since, limit: opts.since ? 200 : 50 });
	const changedRows =
		opts.since && opts.changedSince && !Number.isNaN(Date.parse(opts.changedSince))
			? (await changedMessages(c.id, channelId, new Date(opts.changedSince))).filter(
					(m) =>
						num(m.ts) <= num(opts.since) &&
						(!m.threadTs || m.threadTs === m.ts || m.subtype === 'thread_broadcast')
				)
			: [];
	const conv = await conversationRow(c.id, channelId);
	if (!opts.before) {
		const newest = rows.at(-1)?.ts ?? conv?.latestTs ?? null;
		await markOpened(c.id, channelId, newest);
	}
	const [messages, changed] = await Promise.all([
		toDTOs(ctx, me, rows),
		toDTOs(ctx, me, changedRows)
	]);
	return {
		messages,
		changed,
		hasOlder: opts.before ? rows.length >= 50 || !!conv?.hasOlder : (conv?.hasOlder ?? false),
		retryAfterSec: status.retryAfterSec,
		restricted: ctx.restricted,
		error: status.error,
		syncedAt: syncedAt.toISOString()
	};
}

/** A thread, root first. Falls back to the cache when Slack is rate limiting. */
export async function getThread(userId: string, channelId: string, threadTs: string) {
	const c = await requireSlack(userId);
	const ctx = await slackCall(() => slackCtx(c, 'interactive'));
	const me = await slackUserId(c, ctx.client).catch(() => null);
	await touchClient(c);
	const status = await soft(() =>
		once(`thread:${c.id}:${channelId}:${threadTs}`, () => syncThread(ctx, channelId, threadTs))
	);
	const rows = await cachedThread(c.id, channelId, threadTs);
	return {
		messages: await toDTOs(ctx, me, rows),
		retryAfterSec: status.retryAfterSec,
		restricted: ctx.restricted,
		error: status.error
	};
}

/**
 * Post as the user (chat.postMessage with their user token — never a bot identity). Thread
 * replies follow the thread so its new replies notify, like Slack does.
 */
export async function sendMessage(
	userId: string,
	channelId: string,
	text: string,
	threadTs?: string
): Promise<SlackMessageDTO> {
	const c = await requireSlack(userId);
	return slackCall(async () => {
		const ctx = await slackCtx(c, 'interactive');
		const me = await slackUserId(c, ctx.client);
		const sent = await ctx.client.postMessage(channelId, text, threadTs);
		const message: SlackMessage = {
			...sent.message,
			ts: sent.ts,
			user: sent.message.user ?? me,
			thread_ts: threadTs ?? sent.message.thread_ts
		};
		await upsertMessages(c.id, channelId, [message]);
		if (threadTs) await followAfterReply(ctx, channelId, threadTs, sent.ts);
		return (await toDTOs(ctx, me, [fromApi(message)]))[0]!;
	});
}

async function followAfterReply(
	ctx: SlackCtx,
	channelId: string,
	threadTs: string,
	sentTs: string
) {
	const rows = await cachedThread(ctx.conn.id, channelId, threadTs);
	const root = rows.find((r) => r.ts === threadTs);
	const conv = await conversationRow(ctx.conn.id, channelId);
	const users = conv?.dmUserId ? await cachedUsers(ctx.conn.id, [conv.dmUserId]) : {};
	const channelName = conv ? conversationDTO(conv, users).name : null;
	await db
		.insert(slackThread)
		.values({
			connectionId: ctx.conn.id,
			channelId,
			channelName:
				conv && conv.kind !== 'im' && conv.kind !== 'mpim' ? `#${channelName}` : channelName,
			threadTs,
			preview: root ? clip(root.text) : null,
			replyCount: Math.max(0, rows.length - 1),
			latestTs: sentTs,
			lastReadTs: sentTs,
			lastActivityAt: new Date(num(sentTs) * 1000),
			followed: true
		})
		.onConflictDoUpdate({
			target: [slackThread.connectionId, slackThread.channelId, slackThread.threadTs],
			set: {
				followed: true,
				latestTs: sentTs,
				lastReadTs: sentTs,
				lastActivityAt: new Date(num(sentTs) * 1000)
			}
		});
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

/** search.all over everything the user can see in Slack. */
export async function searchMessages(userId: string, query: string, page = 1) {
	const ctx = await ctxFor(userId);
	const res = await slackCall(() => ctx.client.searchAll(query, page));
	const users = await resolveUsers(
		ctx,
		userIds([
			...res.messages.map((m) => ({ user: m.user, text: m.text })),
			...res.files.map((f) => ({ user: f.user, text: '' }))
		])
	);
	const names = Object.fromEntries(Object.entries(users).map(([id, u]) => [id, u.name]));
	const results: SlackSearchResultDTO[] = res.messages.map((m) => {
		const author = m.user ? (users[m.user]?.name ?? m.user) : (m.username ?? 'Someone');
		const threadTs = parseSlackLink(m.permalink)?.threadTs ?? null;
		return {
			kind: 'message',
			channelId: m.channel.id,
			channelName: m.channel.is_im
				? author
				: m.channel.is_mpim
					? mpimName(m.channel.name ?? null)
					: `#${m.channel.name ?? m.channel.id}`,
			ts: m.ts,
			threadTs: threadTs && threadTs !== m.ts ? threadTs : null,
			at: new Date(num(m.ts) * 1000).toISOString(),
			author,
			segments: parseMrkdwn(m.text, names),
			permalink: m.permalink
		};
	});
	for (const f of res.files) {
		const channelId = f.channels?.[0] ?? f.groups?.[0] ?? f.ims?.[0] ?? null;
		const at = f.timestamp ? new Date(f.timestamp * 1000) : new Date();
		results.push({
			kind: 'file',
			channelId,
			channelName: 'File',
			ts: String(f.timestamp ?? 0),
			threadTs: null,
			at: at.toISOString(),
			author: f.user ? (users[f.user]?.name ?? f.user) : 'Someone',
			segments: [],
			permalink: f.permalink ?? null,
			fileName: f.title || f.name || 'File'
		});
	}
	return { results, pages: res.pages, total: res.total };
}

// ---------------------------------------------------------------------------
// sync control + cache
// ---------------------------------------------------------------------------

/** Resume background polling and poll now. */
export async function startSync(userId: string) {
	const c = await requireSlack(userId);
	if (c.status === 'paused')
		await db.update(conn).set({ status: 'active' }).where(eq(conn.id, c.id));
	await requestPoll(c.id);
}

/** Pause background polling (the open conversation still loads on demand). */
export async function stopSync(userId: string) {
	const c = await requireSlack(userId);
	if (c.status === 'active')
		await db.update(conn).set({ status: 'paused', nextPollAt: null }).where(eq(conn.id, c.id));
}

/** Manual refresh: conversation list now, and a worker poll for mentions/threads. */
export async function refresh(userId: string) {
	const c = await requireSlack(userId);
	await requestPoll(c.id);
	return listConversations(userId, true);
}

export async function clearCache(userId: string) {
	const c = await slackConnection(userId);
	if (!c) error(404, 'Connect Slack first');
	await clearSlackCache(c.id);
	await db
		.update(conn)
		.set({ cursor: dsql`${conn.cursor} - 'listSyncedAt'` })
		.where(and(eq(conn.id, c.id), eq(conn.userId, userId)));
}
