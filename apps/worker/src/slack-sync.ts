import { and, desc, eq, gt, isNull, or, sql as dsql } from 'drizzle-orm';
import { db, schema } from '@corpus/db';
import { notify } from '@corpus/db/notify';
import type { NotificationInput } from '@corpus/core';
import {
	ProviderAuthError,
	SlackApiError,
	mrkdwnToText,
	parseSlackLink,
	type SlackClient,
	type SlackSearchMatch
} from '@corpus/core/integrations';
import {
	DEFAULT_RETENTION_DAYS,
	checkDirectMessages,
	resolveUsers,
	userIds,
	type NewDirectMessage,
	purgeSlackCache,
	recheckWindow,
	slackCtx,
	syncConversations,
	syncNew,
	watchedConversations,
	type SlackCtx
} from '@corpus/db/slack';
import type { Conn, SyncResult } from './integrations';

const { slackThread: thread } = schema;

/** Followed threads quiet for longer than this stop being polled (they wake on a new mention). */
const ACTIVE_DAYS = 14;
/** conversations.replies is Tier 3 (~50/min); stay well under it per poll. */
const THREADS_PER_POLL = 20;
/** A browser had a Slack view open this recently → poll at the active cadence. */
const CLIENT_ACTIVE_MS = 5 * 60_000;
/** Conversation list refresh: active / idle. */
const LIST_ACTIVE_MS = 60_000;
const LIST_IDLE_MS = 10 * 60_000;
/** Background refresh of recently opened conversations: every 60–120 s each. */
const WATCHED_MIN_MS = 60_000;
const WATCHED_JITTER_MS = 60_000;

const tsDate = (ts: string) => new Date(Number(ts) * 1000);
const newer = (a: string | null | undefined, b: string | null | undefined) =>
	Number(a ?? 0) > Number(b ?? 0);
const clip = (s: string, n = 180) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

interface SlackCursor extends Record<string, string> {
	userId: string;
	teamUrl: string;
	/** ts of the newest mention already processed ('0' after an empty first poll) */
	lastMentionTs: string;
	/** ms epoch the Slack page last polled from a browser (set by the web app) */
	clientActiveAt: string;
	/** ms epoch of the last users.conversations refresh */
	listSyncedAt: string;
}

/**
 * Slack (user token):
 *  1. new @mentions → notification + auto-follow their thread,
 *  2. followed threads → notify on replies from others.
 * The first poll imports recent mentions silently.
 */
export async function syncSlack(c: Conn): Promise<SyncResult> {
	const ctx = await slackCtx(c, 'background');
	const slackApi = ctx.client;
	const cursor = { ...c.cursor } as Partial<SlackCursor>;
	// Every poll: picks up scopes granted by a reinstall (Slack upgrades the same token).
	const me = await slackApi.authTest();
	cursor.userId = me.userId;
	cursor.teamUrl = me.url;
	cursor.teamId = me.teamId;
	cursor.teamName = me.team;
	if (me.scopes && me.scopes !== c.scopes)
		await db
			.update(schema.integrationConnection)
			.set({ scopes: me.scopes })
			.where(eq(schema.integrationConnection.id, c.id));
	const active = Date.now() - Number(cursor.clientActiveAt ?? 0) < CLIENT_ACTIVE_MS;
	const firstPoll = cursor.lastMentionTs === undefined;
	const shouldNotify = !firstPoll && c.settings.notify !== false;
	const notes: NotificationInput[] = [];
	let changes = 0;

	// ----- mentions -----
	let matches: SlackSearchMatch[] = [];
	let searched = false;
	try {
		matches = await slackApi.mentions(cursor.userId);
		searched = true;
	} catch (e) {
		// Without search:read (or while rate limited) mentions pause; the rest of the sync still runs.
		if (!(e instanceof SlackApiError)) throw e;
	}
	const cutoff = firstPoll ? (Date.now() - ACTIVE_DAYS * 86_400_000) / 1000 : 0;
	const fresh = matches
		.filter((m) => newer(m.ts, cursor.lastMentionTs) && Number(m.ts) > cutoff)
		.filter((m) => m.user !== cursor.userId)
		.reverse(); // oldest first
	for (const m of fresh) {
		const saved = await followMention(c, slackApi, m);
		changes++;
		if (shouldNotify)
			notes.push({
				userId: c.userId,
				type: 'slack_mention',
				title: `${saved.author} mentioned you in ${saved.channelName}`,
				body: clip(saved.text),
				href: `/integrations/slack?thread=${saved.id}`,
				sourceType: 'integration:slack',
				sourceId: saved.id,
				dedupeKey: `slack_mention:${c.id}:${m.channel.id}:${m.ts}`
			});
	}
	const newest = matches.reduce((max, m) => (newer(m.ts, max) ? m.ts : max), cursor.lastMentionTs);
	// Only advance after a successful search, or the first real one would notify old mentions.
	if (searched) cursor.lastMentionTs = newest ?? '0';

	// ----- followed threads -----
	const followedThreads = await db
		.select()
		.from(thread)
		.where(
			and(
				eq(thread.connectionId, c.id),
				eq(thread.followed, true),
				or(
					isNull(thread.lastActivityAt),
					gt(thread.lastActivityAt, new Date(Date.now() - ACTIVE_DAYS * 86_400_000))
				)
			)
		)
		.orderBy(desc(dsql`coalesce(${thread.lastActivityAt}, now())`))
		.limit(THREADS_PER_POLL);

	for (const t of followedThreads) {
		try {
			const messages = await slackApi.replies(t.channelId, t.threadTs, t.latestTs ?? undefined);
			if (!messages.length) continue;
			const latest = messages.reduce(
				(max, m) => (newer(m.ts, max) ? m.ts : max),
				t.latestTs ?? '0'
			);
			const root = messages.find((m) => m.ts === t.threadTs);
			const fromOthers = t.latestTs
				? messages.filter((m) => m.user !== cursor.userId && newer(m.ts, t.latestTs))
				: [];
			await db
				.update(thread)
				.set({
					latestTs: latest,
					lastActivityAt: tsDate(latest),
					replyCount:
						root?.reply_count ?? t.replyCount + messages.filter((m) => m.ts !== t.threadTs).length,
					...(root && !t.preview && { preview: clip(mrkdwnToText(root.text), 280) })
				})
				.where(eq(thread.id, t.id));
			changes++;
			if (shouldNotify && fromOthers.length) {
				const last = fromOthers.at(-1)!;
				const names = await slackApi.users(fromOthers);
				const nameMap = Object.fromEntries(Object.values(names).map((u) => [u.id, u.name]));
				const who = last.user ? (names[last.user]?.name ?? 'Someone') : (last.username ?? 'A bot');
				notes.push({
					userId: c.userId,
					type: 'slack_thread_reply',
					title:
						fromOthers.length === 1
							? `${who} replied in ${t.channelName ?? 'a thread'}`
							: `${fromOthers.length} new replies in ${t.channelName ?? 'a thread'}`,
					body: clip(`${who}: ${mrkdwnToText(last.text, nameMap)}`),
					href: `/integrations/slack?thread=${t.id}`,
					sourceType: 'integration:slack',
					sourceId: t.id,
					dedupeKey: `slack_thread_reply:${t.id}:${last.ts}`
				});
			}
		} catch (e) {
			if (e instanceof ProviderAuthError) throw e;
			if (e instanceof SlackApiError && e.code === 'ratelimited') break;
			if (
				e instanceof SlackApiError &&
				['thread_not_found', 'channel_not_found'].includes(e.code)
			) {
				await db.update(thread).set({ followed: false }).where(eq(thread.id, t.id));
				continue;
			}
			console.error(`[slack] thread ${t.id}: ${(e as Error).message}`);
		}
	}

	// ----- conversation cache + new DMs -----
	const cacheChanges = await refreshCache(ctx, cursor, active, async (dms) => {
		changes += dms.length;
		if (!shouldNotify || !dms.length) return;
		const users = await resolveUsers(
			ctx,
			userIds(dms.map((d) => ({ user: d.user, text: d.text })))
		);
		const nameMap = Object.fromEntries(Object.entries(users).map(([id, u]) => [id, u.name]));
		for (const d of dms) {
			// A DM that @mentions you already produced a mention notification above.
			if (d.text.includes(`<@${cursor.userId}>`)) continue;
			const who = d.user ? (users[d.user]?.name ?? 'Someone') : (d.username ?? 'A bot');
			notes.push({
				userId: c.userId,
				type: 'slack_dm',
				title: d.kind === 'im' ? `${who} messaged you` : `${who} in a group DM`,
				body: clip(mrkdwnToText(d.text, nameMap)),
				href: `/integrations/slack?c=${d.channelId}`,
				sourceType: 'integration:slack',
				sourceId: d.channelId,
				dedupeKey: `slack_dm:${c.id}:${d.channelId}:${d.ts}`
			});
		}
	});
	changes += cacheChanges;

	await notify(notes);

	// Slower when nobody has the app open; the open conversation is polled by the browser.
	return { cursor: cursor as SlackCursor, intervalSec: active ? 60 : 300, changes };
}

/**
 * Keep the sidebar list and recently opened conversations fresh. Background calls draw from the
 * shared rate budget with a reserve for the open conversation, so this stops at the first refusal.
 */
async function refreshCache(
	ctx: SlackCtx,
	cursor: Partial<SlackCursor>,
	active: boolean,
	onDirectMessages: (dms: NewDirectMessage[]) => Promise<void>
) {
	let changes = 0;
	try {
		const listAge = Date.now() - Number(cursor.listSyncedAt ?? 0);
		if (listAge > (active ? LIST_ACTIVE_MS : LIST_IDLE_MS)) {
			await syncConversations(ctx);
			cursor.listSyncedAt = String(Date.now());
		}
		// DMs are checked even while Corpus is closed — that's when notifications matter most.
		// conversations.info isn't subject to the restricted history limits.
		if (cursor.userId)
			await onDirectMessages(await checkDirectMessages(ctx, cursor.userId, active ? 15 : 10));
		// Restricted (1 req/min) history: only the conversation in front of the user is polled.
		if (!active || ctx.restricted) return changes;
		for (const conv of await watchedConversations(ctx.conn.id)) {
			const due = WATCHED_MIN_MS + Math.random() * WATCHED_JITTER_MS;
			if (conv.lastSyncedAt && Date.now() - conv.lastSyncedAt.getTime() < due) continue;
			try {
				changes += await syncNew(ctx, conv.channelId);
				if (Math.random() < 0.2) changes += await recheckWindow(ctx, conv.channelId);
			} catch (e) {
				if (e instanceof SlackApiError && e.code !== 'ratelimited') continue; // flagged inaccessible
				throw e;
			}
		}
	} catch (e) {
		if (e instanceof ProviderAuthError) throw e;
		// Out of budget or a transient failure: the cache simply catches up next poll.
		if (!(e instanceof SlackApiError)) console.error(`[slack] cache: ${(e as Error).message}`);
	}
	return changes;
}

/** Upsert the thread a mention lives in and mark it followed. */
async function followMention(c: Conn, slackApi: SlackClient, m: SlackSearchMatch) {
	const threadTs = parseSlackLink(m.permalink)?.threadTs ?? m.ts;
	const names = await slackApi.users([{ user: m.user, text: m.text }]);
	const nameMap = Object.fromEntries(Object.values(names).map((u) => [u.id, u.name]));
	const author = m.user ? (names[m.user]?.name ?? 'Someone') : (m.username ?? 'Someone');
	const channelName = m.channel.is_im
		? author
		: m.channel.is_mpim
			? 'a group DM'
			: `#${m.channel.name ?? m.channel.id}`;
	const text = mrkdwnToText(m.text, nameMap);

	const [row] = await db
		.insert(thread)
		.values({
			connectionId: c.id,
			channelId: m.channel.id,
			channelName,
			threadTs,
			permalink: m.permalink,
			preview: threadTs === m.ts ? clip(text, 280) : null,
			authorName: threadTs === m.ts ? author : null,
			mentionTs: m.ts,
			// The mention itself is the newest thing we've seen; replies after it notify.
			latestTs: m.ts,
			lastActivityAt: tsDate(m.ts),
			followed: true
		})
		.onConflictDoUpdate({
			target: [thread.connectionId, thread.channelId, thread.threadTs],
			set: {
				mentionTs: dsql`excluded.mention_ts`,
				followed: true,
				latestTs: dsql`greatest(${thread.latestTs}, excluded.latest_ts)`,
				lastActivityAt: dsql`greatest(${thread.lastActivityAt}, excluded.last_activity_at)`,
				preview: dsql`coalesce(${thread.preview}, excluded.preview)`,
				authorName: dsql`coalesce(${thread.authorName}, excluded.author_name)`
			}
		})
		.returning({ id: thread.id });
	return { id: row!.id, author, channelName, text };
}

/** Daily: drop cached Slack messages older than each connection's retention setting. */
export async function purgeSlackCaches() {
	const rows = await db
		.select({
			id: schema.integrationConnection.id,
			settings: schema.integrationConnection.settings
		})
		.from(schema.integrationConnection)
		.where(eq(schema.integrationConnection.provider, 'slack'));
	for (const r of rows) {
		try {
			await purgeSlackCache(r.id, r.settings.slackRetentionDays ?? DEFAULT_RETENTION_DAYS);
		} catch (e) {
			console.error(`[slack] purge ${r.id}: ${(e as Error).message}`);
		}
	}
}
