/**
 * Slice 1 — note sharing is managed only by the note's creator (while a workspace member) or
 * a workspace owner/admin. Service-level: calls lib/server/notes.ts against the test database.
 */
import { describe, expect, it } from 'vitest';
import { addShare, createLink, listShares, removeShare, revokeLink } from '#lib/server/notes.js';
import {
	ctxFor,
	expectStatus,
	linksOf,
	removeMember,
	setMemberRole,
	sharesOf,
	shareWith
} from './fixtures';
import { world } from './world';

describe('listShares — who can see recipients and link tokens', () => {
	it('S1 view-only recipient cannot read the edit-link token (regression)', async () => {
		const { A, C, CW, N } = await world();
		await shareWith(N.id, C.id, 'view', A.id);
		await expectStatus(listShares(ctxFor(C, CW), N.id), 403);
	});

	it('S2 external editor is denied', async () => {
		const { A, C, CW, N } = await world();
		await shareWith(N.id, C.id, 'edit', A.id);
		await expectStatus(listShares(ctxFor(C, CW), N.id), 403);
	});

	it('S3 ordinary workspace member (not creator) is denied', async () => {
		const { B, W1, N } = await world();
		await expectStatus(listShares(ctxFor(B, W1), N.id), 403);
	});

	it('S4 view share on the parent grants nothing on the child', async () => {
		const { A, C, CW, N, K } = await world();
		await shareWith(N.id, C.id, 'view', A.id);
		await expectStatus(listShares(ctxFor(C, CW), K.id), 403);
	});

	it('S5 creator sees recipients, emails and the link token', async () => {
		const { A, C, W1, N, link } = await world();
		await shareWith(N.id, C.id, 'view', A.id);
		const res = await listShares(ctxFor(A, W1), N.id);
		expect(res.links).toEqual([{ token: link.token, role: 'edit' }]);
		expect(res.shares.map((s) => s.userEmail)).toEqual([C.email]);
	});

	it('caller with no access at all gets 404, not 403', async () => {
		const { C, CW, N } = await world();
		await expectStatus(listShares(ctxFor(C, CW), N.id), 404);
	});
});

describe('share mutations — non-managers are denied and nothing changes', () => {
	const attempts = (noteId: string, shareId: string, email: string) => ({
		addShare: (ctx: ReturnType<typeof ctxFor>) => addShare(ctx, noteId, { email, role: 'edit' }),
		removeShare: (ctx: ReturnType<typeof ctxFor>) => removeShare(ctx, noteId, shareId),
		createLink: (ctx: ReturnType<typeof ctxFor>) => createLink(ctx, noteId, 'edit'),
		revokeLink: (ctx: ReturnType<typeof ctxFor>) => revokeLink(ctx, noteId)
	});

	it('S6 external editor and ordinary member get 403 on all four', async () => {
		const { A, B, C, D, W1, CW, N } = await world();
		const share = await shareWith(N.id, C.id, 'edit', A.id);
		const before = { shares: await sharesOf(N.id), links: await linksOf(N.id) };
		for (const ctx of [ctxFor(C, CW), ctxFor(B, W1)])
			for (const [name, run] of Object.entries(attempts(N.id, share.id, D.email))) {
				await expectStatus(run(ctx), 403).catch((e) => {
					throw new Error(`${name} as ${ctx.user.name}: ${(e as Error).message}`);
				});
			}
		expect(await sharesOf(N.id)).toEqual(before.shares);
		expect(await linksOf(N.id)).toEqual(before.links);
	});

	it('S7 creator can run all four', async () => {
		const { A, B, C, W1, N } = await world();
		const share = await shareWith(N.id, C.id, 'view', A.id);
		const ctx = ctxFor(A, W1);
		await addShare(ctx, N.id, { email: B.email, role: 'view' });
		await removeShare(ctx, N.id, share.id);
		const created = await createLink(ctx, N.id, 'view');
		expect((await linksOf(N.id)).map((l) => l.token)).toEqual([created.token]);
		await revokeLink(ctx, N.id);
		expect(await linksOf(N.id)).toEqual([]);
		expect((await sharesOf(N.id)).map((s) => s.userId)).toEqual([B.id]);
	});
});

describe('workspace owner/admin recovery', () => {
	it('S8 creator who left the workspace loses access entirely', async () => {
		const { A, W1, N } = await world();
		await removeMember(W1, A.id);
		await expectStatus(listShares(ctxFor(A, W1), N.id), 404);
		await expectStatus(createLink(ctxFor(A, W1), N.id, 'edit'), 404);
	});

	it('S9 workspace admin and owner can manage a note they did not create', async () => {
		const { A, C, D, O, W1, N, link } = await world();
		const share = await shareWith(N.id, C.id, 'view', A.id);
		for (const u of [D, O]) {
			const res = await listShares(ctxFor(u, W1), N.id);
			expect(res.links.map((l) => l.token)).toContain(link.token);
		}
		const ctx = ctxFor(D, W1);
		await addShare(ctx, N.id, { email: O.email, role: 'edit' });
		await removeShare(ctx, N.id, share.id);
		await createLink(ctx, N.id, 'view');
		await revokeLink(ctx, N.id);
		expect(await linksOf(N.id)).toEqual([]);
	});

	it('S10 demoted admin is denied', async () => {
		const { D, W1, N } = await world();
		await setMemberRole(W1, D.id, 'member');
		await expectStatus(listShares(ctxFor(D, W1), N.id), 403);
		await expectStatus(createLink(ctxFor(D, W1), N.id, 'edit'), 403);
	});

	it('S11 after the creator leaves, the workspace owner can still manage', async () => {
		const { A, O, W1, N } = await world();
		await removeMember(W1, A.id);
		await listShares(ctxFor(O, W1), N.id);
		const created = await createLink(ctxFor(O, W1), N.id, 'view');
		expect((await linksOf(N.id)).map((l) => l.token)).toEqual([created.token]);
	});

	it('multi-role member string ("member,admin") counts as admin', async () => {
		const { B, W1, N } = await world();
		await setMemberRole(W1, B.id, 'member,admin');
		await listShares(ctxFor(B, W1), N.id);
	});

	it('admin of a different workspace gets nothing', async () => {
		const { A, C, CW, N } = await world();
		await shareWith(N.id, C.id, 'edit', A.id); // C is owner of CW, an editor on N
		await expectStatus(listShares(ctxFor(C, CW), N.id), 403);
	});
});
