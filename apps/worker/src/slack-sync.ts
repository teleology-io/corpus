import { and, desc, eq, gt, isNull, or, sql as dsql } from 'drizzle-orm';
import { db, schema } from '@corpus/db';
import { notify } from '@corpus/db/notify';
import type { NotificationInput } from '@corpus/core';
import {
	ProviderAuthError,
	SlackApiError,
	mrkdwnToText,
	parseSlackLink,
	slackApi,
	type SlackSearchMatch
} from '@corpus/core/integrations';
import type { Conn, SyncResult } from './integrations';

const { slackThread: thread } = schema;

/** Followed threads quiet for longer than this stop being polled (they wake on a new mention). */
const ACTIVE_DAYS = 14;
/** conversations.replies is Tier 3 (~50/min); stay well under it per poll. */
const THREADS_PER_POLL = 20;

const tsDate = (ts: string) => new Date(Number(ts) * 1000);
const newer = (a: string | null | undefined, b: string | null | undefined) =>
	Number(a ?? 0) > Number(b ?? 0);
const clip = (s: string, n = 180) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

interface SlackCursor extends Record<string, string> {
	userId: string;
	teamUrl: string;
	/** ts of the newest mention already processed ('0' after an empty first poll) */
	lastMentionTs: string;
}

/**
 * Slack (user token):
 *  1. new @mentions → notification + auto-follow their thread,
 *  2. followed threads → notify on replies from others.
 * The first poll imports recent mentions silently.
 */
export async function syncSlack(c: Conn, token: string): Promise<SyncResult> {
	const cursor = { ...c.cursor } as Partial<SlackCursor>;
	if (!cursor.userId) {
		const me = await slackApi.authTest(token);
		cursor.userId = me.user_id;
		cursor.teamUrl = me.url;
	}
	const firstPoll = cursor.lastMentionTs === undefined;
	const shouldNotify = !firstPoll && c.settings.notify !== false;
	const notes: NotificationInput[] = [];
	let changes = 0;

	// ----- mentions -----
	const matches = await slackApi.mentions(token, cursor.userId);
	const cutoff = firstPoll ? (Date.now() - ACTIVE_DAYS * 86_400_000) / 1000 : 0;
	const fresh = matches
		.filter((m) => newer(m.ts, cursor.lastMentionTs) && Number(m.ts) > cutoff)
		.filter((m) => m.user !== cursor.userId)
		.reverse(); // oldest first
	for (const m of fresh) {
		const saved = await followMention(c, token, m);
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
	cursor.lastMentionTs = newest ?? '0';

	// ----- followed threads -----
	const active = await db
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

	for (const t of active) {
		try {
			const messages = await slackApi.replies(
				token,
				t.channelId,
				t.threadTs,
				t.latestTs ?? undefined
			);
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
				const names = await slackApi.users(token, fromOthers);
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

	await notify(notes);
	return { cursor: cursor as SlackCursor, intervalSec: 60, changes };
}

/** Upsert the thread a mention lives in and mark it followed. */
async function followMention(c: Conn, token: string, m: SlackSearchMatch) {
	const threadTs = parseSlackLink(m.permalink)?.threadTs ?? m.ts;
	const names = await slackApi.users(token, [{ user: m.user, text: m.text }]);
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
