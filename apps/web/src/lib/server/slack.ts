import { error } from '@sveltejs/kit';
import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '@corpus/db';
import { accessToken } from '@corpus/db/connections';
import {
	ProviderAuthError,
	SlackApiError,
	mrkdwnToText,
	parseMrkdwn,
	parseSlackLink,
	slackApi,
	type SlackMessage
} from '@corpus/core/integrations';
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

async function requireSlack(userId: string) {
	const c = await slackConnection(userId);
	if (!c) error(404, 'Connect Slack first');
	if (c.status === 'error') error(409, 'Slack needs to be reconnected');
	return c;
}

/** Map Slack API failures onto HTTP errors the UI can show. */
async function slackCall<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (e) {
		if (e instanceof ProviderAuthError) error(409, 'Slack needs to be reconnected');
		if (e instanceof SlackApiError) {
			const messages: Record<string, string> = {
				ratelimited: 'Slack is rate limiting requests — try again in a minute',
				thread_not_found: 'That thread no longer exists',
				channel_not_found: 'You don’t have access to that conversation',
				not_in_channel: 'Join the channel in Slack to reply there',
				is_archived: 'That channel is archived'
			};
			error(e.code === 'ratelimited' ? 429 : 400, messages[e.code] ?? `Slack: ${e.code}`);
		}
		throw e;
	}
}

async function slackUserId(c: Conn, token: string) {
	return c.cursor.userId ?? (await slackApi.authTest(token)).user_id;
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

async function toMessages(token: string, me: string, messages: SlackMessage[]) {
	const users = await slackApi.users(token, messages);
	const names = Object.fromEntries(Object.values(users).map((u) => [u.id, u.name]));
	return messages.map((m): SlackMessageDTO => ({
		ts: m.ts,
		at: new Date(Number(m.ts) * 1000).toISOString(),
		author: m.user
			? { name: users[m.user]?.name ?? m.user, image: users[m.user]?.image ?? null }
			: { name: m.username ?? 'Bot', image: null },
		mine: m.user === me,
		edited: !!m.edited,
		segments: parseMrkdwn(m.text, names),
		files: (m.files ?? [])
			.filter((f) => f.permalink)
			.map((f) => ({ name: f.name ?? 'File', url: f.permalink! }))
	}));
}

/** Full thread from Slack; opening it marks it read. */
export async function readThread(userId: string, id: string) {
	const c = await requireSlack(userId);
	const t = await ownThread(c, id);
	return slackCall(async () => {
		const token = await accessToken(c);
		const me = await slackUserId(c, token);
		const raw = await slackApi.replies(token, t.channelId, t.threadTs);
		const latest = raw.reduce((max, m) => (newer(m.ts, max) ? m.ts : max), t.latestTs ?? '0');
		const root = raw.find((m) => m.ts === t.threadTs);
		const messages = await toMessages(token, me, raw);
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
				...(!t.channelName && { channelName: await slackApi.channelName(token, t.channelId) }),
				...(!t.permalink && {
					permalink: await slackApi.permalink(token, t.channelId, t.threadTs)
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
		const token = await accessToken(c);
		const sent = await slackApi.post(token, t.channelId, t.threadTs, text);
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
		const token = await accessToken(c);
		// Validates access and gives us the root + latest reply in one call.
		const raw = await slackApi.replies(token, parsed.channel, parsed.threadTs);
		const root = raw.find((m) => m.ts === parsed.threadTs) ?? raw[0];
		const latest = raw.reduce((max, m) => (newer(m.ts, max) ? m.ts : max), parsed.threadTs);
		const author = root?.user ? (await slackApi.user(token, root.user)).name : root?.username;
		const [row] = await db
			.insert(thread)
			.values({
				connectionId: c.id,
				channelId: parsed.channel,
				channelName: await slackApi.channelName(token, parsed.channel),
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
