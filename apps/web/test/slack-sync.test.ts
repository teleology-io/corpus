import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '@corpus/db';
import { SlackApiError, type SlackClient, type SlackMessage } from '@corpus/core/integrations';
import {
	cachedMessages,
	checkDirectMessages,
	hasSlackUnread,
	clearSlackCache,
	historyRestricted,
	loadOlder,
	purgeSlackCache,
	rateLimitHooks,
	recheckWindow,
	recordRateLimited,
	syncNew,
	syncThread,
	type SlackCtx
} from '@corpus/db/slack';
import { makeUser, reset } from './fixtures';

const CH = 'C0TEST';
const nowTs = () => Date.now() / 1000;
const ts = (sec: number, n = 0) => `${Math.floor(sec)}.${String(n).padStart(6, '0')}`;

/** In-memory Slack channel: `history` honours oldest/latest/limit like conversations.history. */
function fakeSlack(initial: SlackMessage[]) {
	const state = { messages: [...initial], threads: new Map<string, SlackMessage[]>(), calls: 0 };
	const client = {
		async conversationInfo(id: string) {
			return { id, name: 'general', is_channel: true, is_member: true };
		},
		async history(_c: string, o: { oldest?: string; latest?: string; limit?: number } = {}) {
			state.calls++;
			const all = state.messages
				.filter(
					(m) =>
						(!o.oldest || Number(m.ts) > Number(o.oldest)) &&
						(!o.latest || Number(m.ts) < Number(o.latest))
				)
				.sort((a, b) => Number(b.ts) - Number(a.ts));
			const limit = o.limit ?? 100;
			return { messages: all.slice(0, limit), hasMore: all.length > limit, nextCursor: null };
		},
		async replies(_c: string, threadTs: string) {
			state.calls++;
			return state.threads.get(threadTs) ?? [];
		},
		async repliesPage(_c: string, threadTs: string) {
			return { messages: state.threads.get(threadTs) ?? [], nextCursor: null };
		}
	};
	return { state, client: client as unknown as SlackClient };
}

async function makeConn() {
	const u = await makeUser('Slacker');
	const [c] = await db
		.insert(schema.integrationConnection)
		.values({ userId: u.id, provider: 'slack', accessToken: 'x', authType: 'token' })
		.returning();
	return c!;
}

const ctxOf = (conn: SlackCtx['conn'], client: SlackClient, restricted = false): SlackCtx => ({
	conn,
	client,
	restricted,
	pageSize: restricted ? 15 : 100
});

describe('slack cache sync', () => {
	beforeEach(reset);

	it('syncs incrementally and dedupes by (channel, ts)', async () => {
		const conn = await makeConn();
		const base = nowTs() - 3600;
		const fake = fakeSlack([1, 2, 3].map((i) => ({ ts: ts(base + i), text: `m${i}`, user: 'U1' })));
		const ctx = ctxOf(conn, fake.client);

		expect(await syncNew(ctx, CH)).toBe(3);
		expect(await syncNew(ctx, CH)).toBe(0); // nothing new
		fake.state.messages.push({ ts: ts(base + 10), text: 'm4', user: 'U2' });
		expect(await syncNew(ctx, CH)).toBe(1);

		const rows = await cachedMessages(conn.id, CH);
		expect(rows.map((r) => r.text)).toEqual(['m1', 'm2', 'm3', 'm4']);
	});

	it('detects edits and deletions in the recheck window', async () => {
		const conn = await makeConn();
		const base = nowTs() - 3600;
		const fake = fakeSlack([1, 2, 3].map((i) => ({ ts: ts(base + i), text: `m${i}` })));
		const ctx = ctxOf(conn, fake.client);
		await syncNew(ctx, CH);

		fake.state.messages = [
			{ ts: ts(base + 1), text: 'm1' },
			{ ts: ts(base + 3), text: 'm3 (edited)', edited: { ts: ts(base + 100) } }
		];
		expect(await recheckWindow(ctx, CH)).toBe(1);
		const rows = await cachedMessages(conn.id, CH);
		const byText = Object.fromEntries(rows.map((r) => [r.ts, r]));
		expect(byText[ts(base + 2)]!.deletedAt).not.toBeNull();
		expect(byText[ts(base + 3)]!.text).toBe('m3 (edited)');
		expect(byText[ts(base + 3)]!.editedTs).toBe(ts(base + 100));
	});

	it('pages older history and stops when Slack has no more', async () => {
		const conn = await makeConn();
		const base = nowTs() - 3600;
		const fake = fakeSlack(
			Array.from({ length: 20 }, (_, i) => ({ ts: ts(base + i), text: `m${i}` }))
		);
		const ctx = ctxOf(conn, fake.client, true); // 15 per page
		await syncNew(ctx, CH);
		expect((await cachedMessages(conn.id, CH)).length).toBe(15);
		expect(await loadOlder(ctx, CH)).toBe(5);
		expect(await loadOlder(ctx, CH)).toBe(0);
		expect((await cachedMessages(conn.id, CH)).length).toBe(20);
	});

	it('flags inaccessible conversations', async () => {
		const conn = await makeConn();
		const fake = fakeSlack([]);
		fake.client.history = async () => {
			throw new SlackApiError('not_in_channel');
		};
		await expect(syncNew(ctxOf(conn, fake.client), CH)).rejects.toMatchObject({
			code: 'not_in_channel'
		});
		const [row] = await db
			.select()
			.from(schema.slackConversation)
			.where(
				and(
					eq(schema.slackConversation.connectionId, conn.id),
					eq(schema.slackConversation.channelId, CH)
				)
			);
		expect(row!.inaccessibleCode).toBe('not_in_channel');
	});

	it('caches threads root-first and marks removed replies deleted', async () => {
		const conn = await makeConn();
		const root = ts(nowTs() - 600);
		const fake = fakeSlack([]);
		fake.state.threads.set(root, [
			{ ts: root, thread_ts: root, text: 'root', reply_count: 2 },
			{ ts: ts(nowTs() - 500), thread_ts: root, text: 'r1' },
			{ ts: ts(nowTs() - 400), thread_ts: root, text: 'r2' }
		]);
		const ctx = ctxOf(conn, fake.client);
		await syncThread(ctx, CH, root);
		fake.state.threads.set(root, fake.state.threads.get(root)!.slice(0, 2));
		await syncThread(ctx, CH, root);
		const rows = await db
			.select()
			.from(schema.slackMessage)
			.where(eq(schema.slackMessage.threadTs, root))
			.orderBy(schema.slackMessage.tsNum);
		expect(rows.map((r) => [r.text, !!r.deletedAt])).toEqual([
			['root', false],
			['r1', false],
			['r2', true]
		]);
	});

	it('purges by retention and clears everything on request', async () => {
		const conn = await makeConn();
		const fake = fakeSlack([
			{ ts: ts(nowTs() - 40 * 86_400), text: 'old' },
			{ ts: ts(nowTs() - 60), text: 'new' }
		]);
		await syncNew(ctxOf(conn, fake.client), CH);
		expect(await purgeSlackCache(conn.id, 30)).toBe(1);
		expect((await cachedMessages(conn.id, CH)).map((r) => r.text)).toEqual(['new']);
		await clearSlackCache(conn.id);
		expect(await cachedMessages(conn.id, CH)).toEqual([]);
	});
});

describe('slack rate limiter', () => {
	beforeEach(reset);

	it('keeps a reserve for interactive calls', async () => {
		const conn = await makeConn();
		const bg = rateLimitHooks(conn.id, 'background', 'internal');
		const fg = rateLimitHooks(conn.id, 'interactive', 'internal');
		// Bucket holds 10 (burst cap); background stops at 30% reserve.
		let granted = 0;
		for (let i = 0; i < 10; i++) {
			try {
				await bg.acquire!('conversations.history', 'background');
				granted++;
			} catch (e) {
				expect(e).toMatchObject({ code: 'ratelimited' });
				break;
			}
		}
		expect(granted).toBe(7);
		await expect(fg.acquire!('conversations.history', 'interactive')).resolves.toBeUndefined();
	});

	it('blocks until Retry-After and learns the 1/min history limit', async () => {
		const conn = await makeConn();
		const fg = rateLimitHooks(conn.id, 'interactive', 'auto');
		expect(await historyRestricted(conn.id)).toBe(false);
		await recordRateLimited(conn.id, 'conversations.history', 30);
		await expect(fg.acquire!('conversations.history', 'interactive')).rejects.toMatchObject({
			code: 'ratelimited'
		});
		for (let i = 0; i < 5; i++) await recordRateLimited(conn.id, 'conversations.history', 30);
		expect(await historyRestricted(conn.id)).toBe(true);
		expect(await historyRestricted(conn.id, 'internal')).toBe(false);
		expect(await historyRestricted(conn.id, 'distributed')).toBe(true);
	});

	it('never lets background calls run on a 1/min bucket', async () => {
		const conn = await makeConn();
		const bg = rateLimitHooks(conn.id, 'background', 'distributed');
		await expect(bg.acquire!('conversations.history', 'background')).rejects.toMatchObject({
			code: 'ratelimited'
		});
		const fg = rateLimitHooks(conn.id, 'interactive', 'distributed');
		await expect(fg.acquire!('conversations.history', 'interactive')).resolves.toBeUndefined();
	});
});

describe('slack direct messages', () => {
	beforeEach(reset);

	async function dm(connectionId: string) {
		await db
			.insert(schema.slackConversation)
			.values({ connectionId, channelId: 'D0DM', kind: 'im', dmUserId: 'U2' });
	}

	function infoClient(latest: { ts: string; user: string; text: string }, lastRead: string) {
		return {
			async conversationInfo(id: string) {
				return { id, is_im: true, user: 'U2', latest, last_read: lastRead };
			}
		} as unknown as SlackClient;
	}

	it('first check is silent, later messages from others are reported once', async () => {
		const conn = await makeConn();
		await dm(conn.id);
		const t0 = ts(nowTs() - 100);
		const t1 = ts(nowTs() - 50);
		expect(
			await checkDirectMessages(
				ctxOf(conn, infoClient({ ts: t0, user: 'U2', text: 'hi' }, '0')),
				'U1'
			)
		).toEqual([]);
		expect(await hasSlackUnread(conn.id)).toBe(true); // Slack says unread (last_read 0)

		const ctx = ctxOf(conn, infoClient({ ts: t1, user: 'U2', text: 'you there?' }, '0'));
		const fresh = await checkDirectMessages(ctx, 'U1');
		expect(fresh).toMatchObject([{ channelId: 'D0DM', ts: t1, user: 'U2', text: 'you there?' }]);
		expect(await checkDirectMessages(ctx, 'U1')).toEqual([]); // not again
	});

	it('ignores your own messages and ones already read in Slack', async () => {
		const conn = await makeConn();
		await dm(conn.id);
		const t0 = ts(nowTs() - 100);
		await checkDirectMessages(ctxOf(conn, infoClient({ ts: t0, user: 'U2', text: 'a' }, t0)), 'U1');
		const mine = ts(nowTs() - 50);
		expect(
			await checkDirectMessages(
				ctxOf(conn, infoClient({ ts: mine, user: 'U1', text: 'b' }, mine)),
				'U1'
			)
		).toEqual([]);
		expect(await hasSlackUnread(conn.id)).toBe(false);
	});
});
