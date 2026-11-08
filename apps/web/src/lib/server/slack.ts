import { error } from '@sveltejs/kit';
import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '@corpus/db';
import {
	ProviderAuthError,
	SLACK_ERROR_MESSAGES,
	SlackApiError,
	mrkdwnToText,
	parseMrkdwn,
	parseSlackLink,
	type SlackClient,
	type SlackMessage
} from '@corpus/core/integrations';
import {
	hasSlackUnread,
	resolveUsers,
	slackCtx,
	syncThread,
	upsertMessages,
	userIds
} from '@corpus/db/slack';
import type { SlackMessageDTO, SlackThreadDTO } from '#lib/types.js';

const { integrationConnection: conn, slackThread: thread } = schema;
type Conn = typeof conn.$inferSelect;
type Thread = typeof thread.$inferSelect;

const newer = (a: string | null | undefined, b: string | null | undefined) =>
	Number(a ?? 0) > Number(b ?? 0);
const clip = (s: string, n = 280) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export async function slackConnection(userId: string) {
	const [row] = await db
		.select()
		.from(conn)
		.where(and(eq(conn.userId, userId), eq(conn.provider, 'slack')))
		.limit(1);
	return row ?? null;
}

export async function requireSlack(userId: string) {
	const c = await slackConnection(userId);
	if (!c) error(404, 'Connect Slack first');
	if (c.status === 'error') error(409, 'Slack needs to be reconnected');
	return c;
}

/** HTTP status for a Slack error code. */
function slackStatus(code: string) {
	if (code === 'ratelimited' || code === 'rate_limited') return 429;
	if (code === 'missing_scope' || code === 'restricted_action') return 403;
	if (code === 'channel_not_found' || code === 'thread_not_found') return 404;
	if (code === 'network_error' || code.startsWith('http_')) return 502;
	return 400;
}

/** User-facing text for a Slack error (codes only — never tokens or request headers). */
export function slackErrorMessage(e: SlackApiError) {
	if (e.code === 'missing_scope' && e.needed) {
		const list = e.needed
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		return `Your Slack token is missing ${list.length > 1 ? 'the scopes' : 'the scope'} ${list.join(', ')} — add ${list.length > 1 ? 'them' : 'it'} under User Token Scopes, reinstall the app, and update the token`;
	}
	if (e.code === 'network_error' || e.code.startsWith('http_'))
		return 'Couldn’t reach Slack — try again';
	return SLACK_ERROR_MESSAGES[e.code] ?? `Slack: ${e.code}`;
}

/** Map Slack API failures onto HTTP errors the UI can show. */
export async function slackCall<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (e) {
		if (e instanceof ProviderAuthError) error(409, 'Slack needs to be reconnected');
		if (e instanceof SlackApiError) error(slackStatus(e.code), slackErrorMessage(e));
		throw e;
	}
}

export async function slackUserId(c: Conn, client: SlackClient) {
	return c.cursor.userId ?? (await client.authTest()).userId;
}

const toDTO = (t: Thread): SlackThreadDTO => ({
	id: t.id,
	channelName: t.channelName,
	preview: t.preview,
	authorName: t.authorName,
	replyCount: t.replyCount,
	permalink: t.permalink,
	mentioned: !!t.mentionTs,
	followed: t.followed,
	unread: newer(t.latestTs, t.lastReadTs),
	lastActivityAt: t.lastActivityAt?.toISOString() ?? null
});

export async function listThreads(userId: string, limit = 100): Promise<SlackThreadDTO[]> {
	const c = await slackConnection(userId);
	if (!c) return [];
	const rows = await db
		.select()
		.from(thread)
		.where(and(eq(thread.connectionId, c.id), eq(thread.followed, true)))
		.orderBy(desc(thread.lastActivityAt))
		.limit(limit);
	return rows.map(toDTO);
}

async function ownThread(c: Conn, id: string) {
	const [row] = await db
		.select()
		.from(thread)
		.where(and(eq(thread.id, id), eq(thread.connectionId, c.id)))
		.limit(1);
	if (!row) error(404, 'Thread not found');
	return row;
}

async function toMessages(
	ctx: { conn: { id: string }; client: SlackClient },
	me: string,
	messages: SlackMessage[]
) {
	const users = await resolveUsers(ctx, userIds(messages));
	return messages.map((m) => messageDTO(fromApi(m), users, me));
}

/** Shape shared by cached rows and live API messages. */
export interface MessageLike {
	ts: string;
	threadTs: string | null;
	userId: string | null;
	botName: string | null;
	text: string;
	subtype: string | null;
	replyCount: number;
	editedTs: string | null;
	deletedAt: Date | null;
	files: { name: string; mimetype?: string; size?: number; url?: string }[];
}

export const fromApi = (m: SlackMessage): MessageLike => ({
	ts: m.ts,
	threadTs: m.thread_ts ?? null,
	userId: m.user ?? null,
	botName: m.user ? null : (m.username ?? (m.bot_id ? 'Bot' : null)),
	text: m.text ?? '',
	subtype: m.subtype ?? null,
	replyCount: m.reply_count ?? 0,
	editedTs: m.edited?.ts ?? null,
	deletedAt: null,
	files: (m.files ?? []).map((f) => ({
		name: f.title || f.name || 'File',
		mimetype: f.mimetype,
		size: f.size,
		url: f.permalink
	}))
});

const SYSTEM_SUBTYPES = new Set([
	'channel_join',
	'channel_leave',
	'channel_topic',
	'channel_purpose',
	'channel_name',
	'channel_archive',
	'channel_unarchive',
	'group_join',
	'group_leave',
	'pinned_item',
	'tombstone'
]);

export function messageDTO(
	m: MessageLike,
	users: Record<string, { name: string; image: string | null }>,
	me: string | null
): SlackMessageDTO {
	const names = Object.fromEntries(Object.entries(users).map(([id, u]) => [id, u.name]));
	return {
		ts: m.ts,
		at: new Date(Number(m.ts) * 1000).toISOString(),
		threadTs: m.threadTs,
		replyCount: m.replyCount,
		author: m.userId
			? {
					id: m.userId,
					name: users[m.userId]?.name ?? m.userId,
					image: users[m.userId]?.image ?? null
				}
			: { id: null, name: m.botName ?? 'Slack', image: null },
		mine: !!me && m.userId === me,
		edited: !!m.editedTs,
		deleted: !!m.deletedAt || m.subtype === 'tombstone',
		system: !!m.subtype && SYSTEM_SUBTYPES.has(m.subtype),
		segments: m.deletedAt ? [] : parseMrkdwn(m.text, names),
		files: m.files.map((f) => ({
			name: f.name,
			url: f.url && /^https:\/\//.test(f.url) ? f.url : null,
			size: f.size ?? null,
			mimetype: f.mimetype ?? null
		}))
	};
}

/** Full thread from Slack; opening it marks it read. */
export async function readThread(userId: string, id: string) {
	const c = await requireSlack(userId);
	const t = await ownThread(c, id);
	return slackCall(async () => {
		const ctx = await slackCtx(c, 'interactive');
		const me = await slackUserId(c, ctx.client);
		const raw = await syncThread(ctx, t.channelId, t.threadTs);
		const latest = raw.reduce((max, m) => (newer(m.ts, max) ? m.ts : max), t.latestTs ?? '0');
		const root = raw.find((m) => m.ts === t.threadTs);
		const messages = await toMessages(ctx, me, raw);
		const [updated] = await db
			.update(thread)
			.set({
				latestTs: latest,
				lastReadTs: latest,
				replyCount: root?.reply_count ?? Math.max(0, raw.length - 1),
				lastActivityAt: new Date(Number(latest) * 1000),
				...(root && {
					preview: t.preview ?? clip(mrkdwnToText(root.text)),
					authorName: t.authorName ?? messages[0]?.author.name ?? null
				}),
				...(!t.channelName && { channelName: await ctx.client.channelName(t.channelId) }),
				...(!t.permalink && {
					permalink: await ctx.client.permalink(t.channelId, t.threadTs)
				})
			})
			.where(eq(thread.id, t.id))
			.returning();
		return { thread: toDTO(updated!), messages };
	});
}

export async function reply(userId: string, id: string, text: string) {
	const c = await requireSlack(userId);
	const t = await ownThread(c, id);
	return slackCall(async () => {
		const ctx = await slackCtx(c, 'interactive');
		const sent = await ctx.client.postMessage(t.channelId, text, t.threadTs);
		await upsertMessages(c.id, t.channelId, [{ ...sent.message, thread_ts: t.threadTs }]);
		// Our own reply shouldn't count as unread or trigger a reply notification.
		await db
			.update(thread)
			.set({
				latestTs: sent.ts,
				lastReadTs: sent.ts,
				replyCount: t.replyCount + 1,
				lastActivityAt: new Date(Number(sent.ts) * 1000),
				followed: true
			})
			.where(eq(thread.id, t.id));
		return sent.ts;
	});
}

/** Follow a thread from a pasted Slack message link. */
export async function followLink(userId: string, link: string) {
	const c = await requireSlack(userId);
	const parsed = parseSlackLink(link);
	if (!parsed) error(400, 'That doesn’t look like a Slack message link');
	return slackCall(async () => {
		const ctx = await slackCtx(c, 'interactive');
		// Validates access and gives us the root + latest reply in one call.
		const raw = await syncThread(ctx, parsed.channel, parsed.threadTs);
		const root = raw.find((m) => m.ts === parsed.threadTs) ?? raw[0];
		const latest = raw.reduce((max, m) => (newer(m.ts, max) ? m.ts : max), parsed.threadTs);
		const author = root?.user ? (await ctx.client.user(root.user)).name : root?.username;
		const [row] = await db
			.insert(thread)
			.values({
				connectionId: c.id,
				channelId: parsed.channel,
				channelName: await ctx.client.channelName(parsed.channel),
				threadTs: parsed.threadTs,
				permalink: link.trim(),
				preview: root ? clip(mrkdwnToText(root.text)) : null,
				authorName: author ?? null,
				replyCount: root?.reply_count ?? 0,
				latestTs: latest,
				lastReadTs: latest,
				lastActivityAt: new Date(Number(latest) * 1000),
				followed: true
			})
			.onConflictDoUpdate({
				target: [thread.connectionId, thread.channelId, thread.threadTs],
				set: { followed: true }
			})
			.returning({ id: thread.id });
		return row!.id;
	});
}

export async function setFollowed(userId: string, id: string, followed: boolean) {
	const c = await requireSlack(userId);
	const t = await ownThread(c, id);
	await db.update(thread).set({ followed }).where(eq(thread.id, t.id));
}

export async function unreadThreadCount(userId: string) {
	return (await listThreads(userId)).filter((t) => t.unread).length;
}

/** For the nav dot: anything unread in followed threads, channels or DMs (no Slack calls). */
export async function slackUnread(userId: string) {
	const c = await slackConnection(userId);
	return c ? hasSlackUnread(c.id) : false;
}
