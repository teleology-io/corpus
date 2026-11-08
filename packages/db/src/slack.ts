/**
 * Slack cache + incremental sync, shared by the web app (open conversation, on demand) and the
 * worker (background refresh). Tokens never touch these tables.
 *
 * Invariant per conversation: cached channel-level messages cover [oldestTs, latestTs] without
 * gaps. `syncNew` extends the top, `loadOlder` the bottom; a gap too big to page through drops
 * the older cache rather than leaving a hole.
 */
import { and, desc, eq, gt, inArray, isNull, lt, notInArray, or, sql as dsql } from 'drizzle-orm';
import {
	SlackApiError,
	conversationKind,
	createSlackClient,
	userIds,
	type SlackClient,
	type SlackMessage,
	type SlackPriority,
	type SlackUser
} from '@corpus/core/integrations';
import { accessToken } from './connections';
import { db } from './index';
import {
	integrationConnection,
	slackConversation as convT,
	slackMessage as msgT,
	slackThread,
	slackUser as userT
} from './schema/index';
import { historyRestricted, rateLimitHooks, type SlackRateProfile } from './slack-rate';

export * from './slack-rate';

type Conn = typeof integrationConnection.$inferSelect;
export type SlackConversationRow = typeof convT.$inferSelect;
export type SlackMessageRow = typeof msgT.$inferSelect;

/** Errors that mean "this conversation is off limits": stop background polling it. */
export const INACCESSIBLE = new Set([
	'channel_not_found',
	'not_in_channel',
	'missing_scope',
	'is_archived',
	'restricted_action',
	'access_denied'
]);

export const DEFAULT_RETENTION_DAYS = 30;
/** Max history pages per incremental sync before we drop the older cache instead. */
const MAX_PAGES = 5;
const USER_TTL_MS = 24 * 3_600_000;

export interface SlackCtx {
	conn: Conn;
	client: SlackClient;
	/** conversations.history/replies are on the 1/min, 15-per-page limits */
	restricted: boolean;
	pageSize: number;
}

/** A metered client for one connection. */
export async function slackCtx(conn: Conn, priority: SlackPriority): Promise<SlackCtx> {
	const profile: SlackRateProfile = conn.settings.slackRateProfile ?? 'auto';
	const token = await accessToken(conn);
	const restricted = await historyRestricted(conn.id, profile);
	return {
		conn,
		client: createSlackClient(token, rateLimitHooks(conn.id, priority, profile)),
		restricted,
		pageSize: restricted ? 15 : 100
	};
}

const num = (ts: string) => Number(ts);
const maxTs = (list: string[], start?: string | null) =>
	list.reduce((m, t) => (num(t) > num(m ?? '0') ? t : m), start ?? null);
const minTs = (list: string[], start?: string | null) =>
	list.reduce((m, t) => (m === null || num(t) < num(m) ? t : m), start ?? null);

/** Channel-level rows: plain messages, thread roots, and replies broadcast to the channel. */
const channelLevel = or(
	isNull(msgT.threadTs),
	eq(msgT.threadTs, msgT.ts),
	eq(msgT.subtype, 'thread_broadcast')
)!;

// ---------------------------------------------------------------------------
// cache writes
// ---------------------------------------------------------------------------

export async function upsertMessages(
	connectionId: string,
	channelId: string,
	list: SlackMessage[]
) {
	if (!list.length) return;
	const seen = new Map<string, SlackMessage>();
	for (const m of list) seen.set(m.ts, m); // dedupe within a batch (same ts twice)
	await db
		.insert(msgT)
		.values(
			[...seen.values()].map((m) => ({
				connectionId,
				channelId,
				ts: m.ts,
				threadTs: m.thread_ts ?? null,
				tsNum: num(m.ts),
				userId: m.user ?? null,
				botName: m.user ? null : (m.username ?? (m.bot_id ? 'Bot' : null)),
				text: m.text ?? '',
				subtype: m.subtype ?? null,
				replyCount: m.reply_count ?? 0,
				latestReply: m.latest_reply ?? null,
				files: (m.files ?? []).map((f) => ({
					name: f.title || f.name || 'File',
					mimetype: f.mimetype,
					size: f.size,
					url: f.permalink
				})),
				editedTs: m.edited?.ts ?? null,
				deletedAt: null
			}))
		)
		.onConflictDoUpdate({
			target: [msgT.connectionId, msgT.channelId, msgT.ts],
			set: {
				threadTs: dsql`coalesce(excluded.thread_ts, ${msgT.threadTs})`,
				userId: dsql`excluded.user_id`,
				botName: dsql`excluded.bot_name`,
				text: dsql`excluded.text`,
				subtype: dsql`excluded.subtype`,
				// Replies fetched via conversations.replies don't carry the root's counters.
				replyCount: dsql`greatest(excluded.reply_count, ${msgT.replyCount})`,
				latestReply: dsql`coalesce(excluded.latest_reply, ${msgT.latestReply})`,
				files: dsql`excluded.files`,
				editedTs: dsql`excluded.edited_ts`,
				deletedAt: null
			}
		});
}

async function conversation(ctx: SlackCtx, channelId: string) {
	const [row] = await db
		.select()
		.from(convT)
		.where(and(eq(convT.connectionId, ctx.conn.id), eq(convT.channelId, channelId)))
		.limit(1);
	if (row) return row;
	// Not in the member list (e.g. opened from search or browse): look it up once.
	const info = await ctx.client.conversationInfo(channelId);
	const [created] = await db
		.insert(convT)
		.values({
			connectionId: ctx.conn.id,
			channelId,
			kind: conversationKind(info),
			name: info.name ?? null,
			dmUserId: info.is_im ? (info.user ?? null) : null,
			topic: info.topic?.value || info.purpose?.value || null,
			isMember: info.is_member ?? !!info.is_im,
			isArchived: !!info.is_archived
		})
		.onConflictDoUpdate({
			target: [convT.connectionId, convT.channelId],
			set: { name: dsql`excluded.name` }
		})
		.returning();
	return created!;
}

async function patchConversation(id: string, set: Partial<typeof convT.$inferInsert>) {
	await db.update(convT).set(set).where(eq(convT.id, id));
}

/** Run a per-conversation Slack call; access errors flag the conversation instead of failing silently. */
async function guarded<T>(row: SlackConversationRow, fn: () => Promise<T>): Promise<T> {
	try {
		const out = await fn();
		if (row.inaccessibleCode)
			await patchConversation(row.id, { inaccessibleCode: null, inaccessibleAt: null });
		return out;
	} catch (e) {
		if (e instanceof SlackApiError && INACCESSIBLE.has(e.code))
			await patchConversation(row.id, { inaccessibleCode: e.code, inaccessibleAt: new Date() });
		throw e;
	}
}

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

/** Refresh the member conversation list (users.conversations). Returns how many changed. */
export async function syncConversations(ctx: SlackCtx) {
	const all = [];
	let cursor: string | undefined;
	let pages = 0;
	do {
		const page = await ctx.client.usersConversations(cursor);
		all.push(...page.items);
		cursor = page.nextCursor ?? undefined;
	} while (cursor && ++pages < 20);
	if (all.length) {
		await db
			.insert(convT)
			.values(
				all.map((c) => ({
					connectionId: ctx.conn.id,
					channelId: c.id,
					kind: conversationKind(c),
					name: c.name ?? null,
					dmUserId: c.is_im ? (c.user ?? null) : null,
					topic: c.topic?.value || c.purpose?.value || null,
					isMember: true,
					isArchived: !!c.is_archived
				}))
			)
			.onConflictDoUpdate({
				target: [convT.connectionId, convT.channelId],
				set: {
					kind: dsql`excluded.kind`,
					name: dsql`excluded.name`,
					dmUserId: dsql`excluded.dm_user_id`,
					topic: dsql`excluded.topic`,
					isMember: true,
					isArchived: dsql`excluded.is_archived`
				}
			});
	}
	// Left / removed conversations stay cached but drop out of the sidebar.
	if (!cursor)
		await db
			.update(convT)
			.set({ isMember: false })
			.where(
				and(
					eq(convT.connectionId, ctx.conn.id),
					eq(convT.isMember, true),
					all.length
						? notInArray(
								convT.channelId,
								all.map((c) => c.id)
							)
						: undefined
				)
			);
	return all.length;
}

/**
 * Fetch messages newer than the cache (first open: the newest page). Returns the new messages'
 * count. Thread replies don't show up here — `syncThread` covers those.
 */
export async function syncNew(ctx: SlackCtx, channelId: string) {
	const row = await conversation(ctx, channelId);
	return guarded(row, async () => {
		if (!row.latestTs) {
			const page = await ctx.client.history(channelId, { limit: ctx.pageSize });
			await upsertMessages(ctx.conn.id, channelId, page.messages);
			const ts = page.messages.map((m) => m.ts);
			await patchConversation(row.id, {
				latestTs: maxTs(ts),
				oldestTs: minTs(ts),
				hasOlder: page.hasMore,
				lastSyncedAt: new Date()
			});
			return page.messages.length;
		}
		const fetched: SlackMessage[] = [];
		let cursor: string | undefined;
		let more = false;
		let pages = 0;
		const maxPages = ctx.restricted ? 1 : MAX_PAGES;
		do {
			const page = await ctx.client.history(channelId, {
				oldest: row.latestTs!,
				limit: ctx.pageSize,
				cursor
			});
			fetched.push(...page.messages);
			cursor = page.nextCursor ?? undefined;
			more = page.hasMore;
		} while (cursor && more && ++pages < maxPages);
		const fresh = fetched.filter((m) => num(m.ts) > num(row.latestTs!));
		await upsertMessages(ctx.conn.id, channelId, fresh);
		const ts = fresh.map((m) => m.ts);
		if (more && fresh.length) {
			// Too far behind to page through: keep only the fresh window so the cache stays contiguous.
			const floor = minTs(ts)!;
			await db
				.delete(msgT)
				.where(
					and(
						eq(msgT.connectionId, ctx.conn.id),
						eq(msgT.channelId, channelId),
						lt(msgT.tsNum, num(floor))
					)
				);
			await patchConversation(row.id, {
				latestTs: maxTs(ts),
				oldestTs: floor,
				hasOlder: true,
				lastSyncedAt: new Date()
			});
		} else {
			await patchConversation(row.id, {
				latestTs: maxTs(ts, row.latestTs),
				lastSyncedAt: new Date()
			});
		}
		return fresh.length;
	});
}

/**
 * Re-read the newest page and reconcile it with the cache: edits, reply counts, and deletions
 * (cached messages inside the page's time span that Slack no longer returns).
 */
export async function recheckWindow(ctx: SlackCtx, channelId: string, size = 50) {
	const row = await conversation(ctx, channelId);
	return guarded(row, async () => {
		const page = await ctx.client.history(channelId, { limit: Math.min(size, ctx.pageSize) });
		await upsertMessages(ctx.conn.id, channelId, page.messages);
		if (!page.messages.length) return 0;
		const floor = num(minTs(page.messages.map((m) => m.ts))!);
		const deleted = await db
			.update(msgT)
			.set({ deletedAt: new Date() })
			.where(
				and(
					eq(msgT.connectionId, ctx.conn.id),
					eq(msgT.channelId, channelId),
					channelLevel,
					isNull(msgT.deletedAt),
					dsql`${msgT.tsNum} >= ${floor}`,
					notInArray(
						msgT.ts,
						page.messages.map((m) => m.ts)
					)
				)
			)
			.returning({ id: msgT.id });
		return deleted.length;
	});
}

/** One page of history older than the cache. */
export async function loadOlder(ctx: SlackCtx, channelId: string) {
	const row = await conversation(ctx, channelId);
	if (!row.oldestTs) return syncNew(ctx, channelId);
	if (!row.hasOlder) return 0;
	return guarded(row, async () => {
		const page = await ctx.client.history(channelId, {
			latest: row.oldestTs!,
			limit: ctx.pageSize
		});
		await upsertMessages(ctx.conn.id, channelId, page.messages);
		await patchConversation(row.id, {
			oldestTs: minTs(
				page.messages.map((m) => m.ts),
				row.oldestTs
			),
			hasOlder: page.hasMore
		});
		return page.messages.length;
	});
}

/** Fetch a whole thread (root first) into the cache; replies Slack no longer returns are marked deleted. */
export async function syncThread(ctx: SlackCtx, channelId: string, threadTs: string) {
	const row = await conversation(ctx, channelId);
	return guarded(row, async () => {
		const messages = ctx.restricted
			? (await ctx.client.repliesPage(channelId, threadTs, { limit: 15 })).messages
			: await ctx.client.replies(channelId, threadTs);
		await upsertMessages(
			ctx.conn.id,
			channelId,
			messages.map((m) => ({ ...m, thread_ts: m.thread_ts ?? threadTs }))
		);
		if (!ctx.restricted && messages.length < 1000)
			await db
				.update(msgT)
				.set({ deletedAt: new Date() })
				.where(
					and(
						eq(msgT.connectionId, ctx.conn.id),
						eq(msgT.channelId, channelId),
						eq(msgT.threadTs, threadTs),
						isNull(msgT.deletedAt),
						messages.length
							? notInArray(
									msgT.ts,
									messages.map((m) => m.ts)
								)
							: undefined
					)
				);
		return messages;
	});
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

export async function conversationRows(connectionId: string) {
	return db
		.select()
		.from(convT)
		.where(and(eq(convT.connectionId, connectionId), eq(convT.isMember, true)));
}

export async function conversationRow(connectionId: string, channelId: string) {
	const [row] = await db
		.select()
		.from(convT)
		.where(and(eq(convT.connectionId, connectionId), eq(convT.channelId, channelId)))
		.limit(1);
	return row ?? null;
}

/** Cached channel-level messages, oldest first. `since` = only newer than; `before` = page older than. */
export async function cachedMessages(
	connectionId: string,
	channelId: string,
	opts: { since?: string; before?: string; limit?: number } = {}
) {
	const rows = await db
		.select()
		.from(msgT)
		.where(
			and(
				eq(msgT.connectionId, connectionId),
				eq(msgT.channelId, channelId),
				channelLevel,
				opts.since ? gt(msgT.tsNum, num(opts.since)) : undefined,
				opts.before ? lt(msgT.tsNum, num(opts.before)) : undefined
			)
		)
		.orderBy(desc(msgT.tsNum))
		.limit(opts.limit ?? 100);
	return rows.reverse();
}

/** Messages edited or deleted since a time (lets the open view patch rows it already shows). */
export async function changedMessages(connectionId: string, channelId: string, since: Date) {
	return db
		.select()
		.from(msgT)
		.where(
			and(
				eq(msgT.connectionId, connectionId),
				eq(msgT.channelId, channelId),
				gt(msgT.updatedAt, since)
			)
		);
}

export async function cachedThread(connectionId: string, channelId: string, threadTs: string) {
	return db
		.select()
		.from(msgT)
		.where(
			and(
				eq(msgT.connectionId, connectionId),
				eq(msgT.channelId, channelId),
				or(eq(msgT.threadTs, threadTs), eq(msgT.ts, threadTs))
			)
		)
		.orderBy(msgT.tsNum);
}

/** Display names, from the cache first, then users.info (cached for a day). */
export async function resolveUsers(
	ctx: { conn: { id: string }; client: SlackClient },
	ids: Iterable<string>
): Promise<Record<string, SlackUser>> {
	const want = [...new Set(ids)].filter(Boolean);
	if (!want.length) return {};
	const rows = await db
		.select()
		.from(userT)
		.where(and(eq(userT.connectionId, ctx.conn.id), inArray(userT.userId, want)));
	const out: Record<string, SlackUser> = {};
	const fresh = Date.now() - USER_TTL_MS;
	for (const r of rows) out[r.userId] = { id: r.userId, name: r.name, image: r.image };
	const missing = want.filter(
		(id) => !rows.some((r) => r.userId === id && r.updatedAt.getTime() > fresh)
	);
	if (missing.length) {
		const fetched = await Promise.all(
			missing.slice(0, 50).map((id) => ctx.client.user(id).catch(() => null))
		);
		const real = fetched.filter((u): u is SlackUser => !!u && u.name !== u.id);
		if (real.length)
			await db
				.insert(userT)
				.values(
					real.map((u) => ({
						connectionId: ctx.conn.id,
						userId: u.id,
						name: u.name,
						image: u.image
					}))
				)
				.onConflictDoUpdate({
					target: [userT.connectionId, userT.userId],
					set: { name: dsql`excluded.name`, image: dsql`excluded.image`, updatedAt: new Date() }
				});
		for (const u of fetched) if (u && !out[u.id]) out[u.id] = u;
		for (const u of real) out[u.id] = u;
	}
	for (const id of want) out[id] ??= { id, name: id, image: null };
	return out;
}

/** User names already cached (no Slack calls) — for list views. */
export async function cachedUsers(connectionId: string, ids: string[]) {
	if (!ids.length) return {};
	const rows = await db
		.select()
		.from(userT)
		.where(and(eq(userT.connectionId, connectionId), inArray(userT.userId, ids)));
	return Object.fromEntries(
		rows.map((r) => [r.userId, { id: r.userId, name: r.name, image: r.image }])
	);
}

export { userIds };

// ---------------------------------------------------------------------------
// direct messages
// ---------------------------------------------------------------------------

export interface NewDirectMessage {
	channelId: string;
	kind: 'im' | 'mpim';
	name: string | null;
	ts: string;
	user: string | null;
	username: string | null;
	text: string;
}

/**
 * Check DMs and group DMs with conversations.info (Tier 3, one call each — Slack has no batch
 * unread API for user tokens). Least recently checked first, at most `limit` per call, stopping
 * at the first rate-limit refusal. Returns messages from others that arrived since the last
 * check; a conversation's first check only records state (no backfill notifications).
 */
export async function checkDirectMessages(ctx: SlackCtx, me: string, limit = 10) {
	const rows = await db
		.select()
		.from(convT)
		.where(
			and(
				eq(convT.connectionId, ctx.conn.id),
				eq(convT.isMember, true),
				inArray(convT.kind, ['im', 'mpim']),
				isNull(convT.inaccessibleCode)
			)
		)
		.orderBy(dsql`${convT.checkedAt} asc nulls first`)
		.limit(limit);
	const fresh: NewDirectMessage[] = [];
	for (const row of rows) {
		let info;
		try {
			info = await ctx.client.conversationInfo(row.channelId);
		} catch (e) {
			if (e instanceof SlackApiError && e.code === 'ratelimited') break;
			if (e instanceof SlackApiError && INACCESSIBLE.has(e.code)) {
				await patchConversation(row.id, {
					inaccessibleCode: e.code,
					inaccessibleAt: new Date(),
					checkedAt: new Date()
				});
				continue;
			}
			throw e;
		}
		const latest = info.latest?.ts ?? null;
		const seenBefore = row.checkedAt !== null;
		if (
			seenBefore &&
			latest &&
			num(latest) > num(row.remoteLatestTs ?? '0') &&
			num(latest) > num(row.lastReadTs ?? '0') &&
			num(latest) > num(info.last_read ?? '0') &&
			info.latest?.user !== me
		)
			fresh.push({
				channelId: row.channelId,
				kind: row.kind as 'im' | 'mpim',
				name: row.name,
				ts: latest,
				user: info.latest?.user ?? null,
				username: info.latest?.username ?? null,
				text: info.latest?.text ?? ''
			});
		await patchConversation(row.id, {
			remoteLatestTs: latest ?? row.remoteLatestTs,
			slackLastRead: info.last_read ?? row.slackLastRead,
			checkedAt: new Date()
		});
	}
	return fresh;
}

/** Unread = Slack's newest message is past both Corpus's and Slack's read markers. */
export function conversationUnread(r: SlackConversationRow) {
	const newest = Math.max(num(r.latestTs ?? '0'), num(r.remoteLatestTs ?? '0'));
	const read = Math.max(num(r.lastReadTs ?? '0'), num(r.slackLastRead ?? '0'));
	// Never-opened channels have no marker yet; DMs get Slack's marker from conversations.info.
	if (!r.lastReadTs && !r.slackLastRead) return false;
	return newest > read;
}

/** Anything unread for the nav dot: followed threads or conversations (cache only, no Slack calls). */
export async function hasSlackUnread(connectionId: string) {
	const [t] = await db
		.select({ one: dsql<number>`1` })
		.from(slackThread)
		.where(
			and(
				eq(slackThread.connectionId, connectionId),
				eq(slackThread.followed, true),
				dsql`coalesce(${slackThread.latestTs}, '0')::numeric > coalesce(${slackThread.lastReadTs}, '0')::numeric`
			)
		)
		.limit(1);
	if (t) return true;
	const [c] = await db
		.select({ one: dsql<number>`1` })
		.from(convT)
		.where(
			and(
				eq(convT.connectionId, connectionId),
				eq(convT.isMember, true),
				eq(convT.isArchived, false),
				or(dsql`${convT.lastReadTs} is not null`, dsql`${convT.slackLastRead} is not null`),
				dsql`greatest(coalesce(${convT.latestTs}, '0')::numeric, coalesce(${convT.remoteLatestTs}, '0')::numeric)
					> greatest(coalesce(${convT.lastReadTs}, '0')::numeric, coalesce(${convT.slackLastRead}, '0')::numeric)`
			)
		)
		.limit(1);
	return !!c;
}

// ---------------------------------------------------------------------------
// housekeeping
// ---------------------------------------------------------------------------

/** Conversations the user opened recently that background sync should keep fresh. */
export async function watchedConversations(connectionId: string, days = 7, limit = 20) {
	return db
		.select()
		.from(convT)
		.where(
			and(
				eq(convT.connectionId, connectionId),
				isNull(convT.inaccessibleCode),
				gt(convT.lastOpenedAt, new Date(Date.now() - days * 86_400_000))
			)
		)
		.orderBy(dsql`${convT.lastSyncedAt} asc nulls first`)
		.limit(limit);
}

export async function markOpened(connectionId: string, channelId: string, readTs?: string | null) {
	await db
		.update(convT)
		.set({
			lastOpenedAt: new Date(),
			// Opening means the user wants it: retry conversations that failed before.
			inaccessibleCode: null,
			inaccessibleAt: null,
			...(readTs && { lastReadTs: readTs })
		})
		.where(and(eq(convT.connectionId, connectionId), eq(convT.channelId, channelId)));
}

/** Drop cached messages older than the retention window (followed thread roots included). */
export async function purgeSlackCache(connectionId: string, days = DEFAULT_RETENTION_DAYS) {
	const cutoff = Date.now() / 1000 - days * 86_400;
	const removed = await db
		.delete(msgT)
		.where(and(eq(msgT.connectionId, connectionId), lt(msgT.tsNum, cutoff)))
		.returning({ id: msgT.id });
	if (!removed.length) return 0;
	// Keep the contiguity invariant: oldestTs follows what's left; empty conversations resync.
	await db.execute(dsql`
		update slack_conversation c set
			oldest_ts = m.oldest, has_older = true
		from (
			select channel_id, (array_agg(ts order by ts_num))[1] as oldest
			from slack_message
			where connection_id = ${connectionId}
				and (thread_ts is null or thread_ts = ts or subtype = 'thread_broadcast')
			group by channel_id
		) m
		where c.connection_id = ${connectionId} and c.channel_id = m.channel_id`);
	await db.execute(dsql`
		update slack_conversation c set latest_ts = null, oldest_ts = null, has_older = true
		where c.connection_id = ${connectionId} and not exists (
			select 1 from slack_message m
			where m.connection_id = c.connection_id and m.channel_id = c.channel_id)`);
	return removed.length;
}

/** Remove every cached Slack conversation, message and user for a connection. */
export async function clearSlackCache(connectionId: string) {
	await db.delete(msgT).where(eq(msgT.connectionId, connectionId));
	await db.delete(convT).where(eq(convT.connectionId, connectionId));
	await db.delete(userT).where(eq(userT.connectionId, connectionId));
}

/** Reconnecting as a different Slack user/workspace: drop data that belonged to the old one. */
export async function resetSlackAccount(connectionId: string) {
	await clearSlackCache(connectionId);
	await db.delete(slackThread).where(eq(slackThread.connectionId, connectionId));
}
