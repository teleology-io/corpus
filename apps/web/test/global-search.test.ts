import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, schema } from '@corpus/db';
import { searchAll } from '#lib/server/search.js';
import { searchDb } from '#lib/server/search-db.js';
import { searchNotes } from '#lib/server/notes.js';
import { getTask } from '#lib/server/planner.js';
import { ctxFor, expectStatus, shareWith } from './fixtures';
import { world } from './world';

describe('global search coverage and permissions', () => {
	it('includes direct/team shares, excludes unshared children and revoked or archived shares', async () => {
		const { A, C, CW, W1, N } = await world();
		const ctx = ctxFor(C, CW);
		expect(await searchNotes(ctx, 'Plan')).toEqual([]);
		await shareWith(N.id, C.id, 'view', A.id);
		expect((await searchNotes(ctx, 'Plan')).map((n) => n.id)).toEqual([N.id]);
		await db.delete(schema.noteShare).where(eq(schema.noteShare.noteId, N.id));
		expect(await searchNotes(ctx, 'Plan')).toEqual([]);
		const teamId = randomUUID();
		await db
			.insert(schema.team)
			.values({ id: teamId, name: 'Team', organizationId: W1, createdAt: new Date() });
		await db.insert(schema.teamMember).values({ id: randomUUID(), teamId, userId: C.id });
		await db
			.insert(schema.noteShare)
			.values({ noteId: N.id, teamId, role: 'view', createdBy: A.id });
		expect((await searchNotes(ctx, 'Plan')).map((n) => n.id)).toEqual([N.id]);
		await db.update(schema.note).set({ archivedAt: new Date() }).where(eq(schema.note.id, N.id));
		expect(await searchNotes(ctx, 'Plan')).toEqual([]);
		await db.update(schema.note).set({ archivedAt: null }).where(eq(schema.note.id, N.id));
		await db.delete(schema.teamMember).where(eq(schema.teamMember.teamId, teamId));
		expect(await searchNotes(ctx, 'Plan')).toEqual([]);
	});

	it('finds transcript-only matches and cached Slack replies, scoped to the owner', async () => {
		const { A, C, W1, CW } = await world();
		const [video] = await db
			.insert(schema.telescopeVideo)
			.values({
				workspaceId: W1,
				ownerId: A.id,
				title: 'Recording',
				status: 'ready',
				mime: 'video/webm',
				fileKey: 'test',
				transcript: [{ start: 0, end: 4, text: 'quasar nebula' }]
			})
			.returning();
		const [connection] = await db
			.insert(schema.integrationConnection)
			.values({ userId: A.id, provider: 'slack', accessToken: 'test' })
			.returning();
		await db
			.insert(schema.slackConversation)
			.values({ connectionId: connection.id, channelId: 'C12345', name: 'space', kind: 'public' });
		await db.insert(schema.slackMessage).values({
			connectionId: connection.id,
			channelId: 'C12345',
			ts: '1700000000.000002',
			tsNum: 1700000000.000002,
			threadTs: '1700000000.000001',
			text: 'quasar nebula'
		});
		const result = await searchAll(ctxFor(A, W1), 'quasar nebula', new AbortController().signal);
		expect(result.failedSources).toEqual([]);
		expect(result.results.some((r) => r.href === `/telescope/${video.id}`)).toBe(true);
		const slack = result.results.find((r) => r.kind === 'Slack')!;
		const link = new URL(slack.href, 'http://test');
		expect(link.searchParams.get('c')).toBe('C12345');
		expect(link.searchParams.get('ts')).toBe('1700000000.000002');
		expect(link.searchParams.get('t')).toBe('1700000000.000001');
		expect((await searchAll(ctxFor(C, CW), 'quasar nebula')).results).toEqual([]);
		await db.update(schema.slackMessage).set({ deletedAt: new Date() });
		expect(
			(await searchAll(ctxFor(A, W1), 'quasar')).results.filter((r) => r.kind === 'Slack')
		).toEqual([]);
	});

	it('fetches exact title matches before recent body matches and enforces task detail visibility', async () => {
		const { A, C, W1, CW } = await world();
		const [exact] = await db
			.insert(schema.task)
			.values({ workspaceId: W1, title: 'quasar' })
			.returning();
		await db.insert(schema.task).values(
			Array.from({ length: 12 }, (_, i) => ({
				workspaceId: W1,
				title: `Other ${i}`,
				notes: 'quasar',
				createdAt: new Date(Date.now() + i * 1000)
			}))
		);
		const result = await searchAll(ctxFor(A, W1), 'quasar');
		expect(result.results[0].href).toBe(`/tasks/${exact.id}`);
		expect((await getTask(ctxFor(A, W1), exact.id)).id).toBe(exact.id);
		await expectStatus(getTask(ctxFor(C, CW), exact.id), 404);
	});
});

it('cancels an in-flight driver query and leaves unrelated work usable', async () => {
	const controller = new AbortController();
	const pending = searchDb(controller.signal).execute(sql`select pg_sleep(10)`);
	const timer = setTimeout(() => controller.abort(), 100);
	try {
		await expect(pending).rejects.toThrow();
		expect(controller.signal.aborted).toBe(true);
		await expect(db.execute(sql`select 1`)).resolves.toHaveLength(1);
	} finally {
		clearTimeout(timer);
	}
});
