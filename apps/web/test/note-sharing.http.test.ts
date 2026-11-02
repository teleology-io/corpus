/**
 * Slice 1 — handler level: the real +server.ts / +page.server.ts modules with fake locals.
 * (No running server; HTTP status comes from SvelteKit's thrown HttpError.)
 */
import { describe, expect, it } from 'vitest';
import * as sharesRoute from '../src/routes/api/notes/[id]/shares/+server';
import * as linkRoute from '../src/routes/api/notes/[id]/link/+server';
import { load as notePageLoad } from '../src/routes/(app)/notes/[id]/+page.server';
import { expectStatus, localsFor, removeMember, shareWith } from './fixtures';
import { world } from './world';

type AnyEvent = never;
const json = (body: unknown, method = 'POST') =>
	new Request('http://test.local/x', {
		method,
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
const event = (locals: App.Locals, id: string, request?: Request) =>
	({ locals, params: { id }, request, url: new URL('http://test.local/') }) as unknown as AnyEvent;

describe('sharing endpoints', () => {
	it('H1 viewer is refused on every sharing endpoint', async () => {
		const { A, C, CW, N } = await world();
		await shareWith(N.id, C.id, 'view', A.id);
		const locals = localsFor(C, CW);
		await expectStatus(
			Promise.resolve().then(() => sharesRoute.GET(event(locals, N.id))),
			403
		);
		await expectStatus(
			Promise.resolve().then(() =>
				sharesRoute.POST(event(locals, N.id, json({ email: A.email, role: 'edit' })))
			),
			403
		);
		await expectStatus(
			Promise.resolve().then(() =>
				sharesRoute.DELETE(event(locals, N.id, json({ shareId: crypto.randomUUID() }, 'DELETE')))
			),
			403
		);
		await expectStatus(
			Promise.resolve().then(() => linkRoute.POST(event(locals, N.id, json({ role: 'edit' })))),
			403
		);
		await expectStatus(
			Promise.resolve().then(() => linkRoute.DELETE(event(locals, N.id))),
			403
		);
	});

	it('H2 creator gets the existing response shapes', async () => {
		const { A, W1, N, link } = await world();
		const locals = localsFor(A, W1);
		const list = await sharesRoute.GET(event(locals, N.id));
		expect(list.status).toBe(200);
		expect((await list.json()).links).toEqual([{ token: link.token, role: 'edit' }]);
		const created = await linkRoute.POST(event(locals, N.id, json({ role: 'view' })));
		expect(created.status).toBe(200);
		expect((await created.json()).url).toMatch(/^http:\/\/test\.local\/share\//);
		expect((await linkRoute.DELETE(event(locals, N.id))).status).toBe(204);
	});
});

describe('note page load — canManage flag and admin recovery path', () => {
	const load = (locals: App.Locals, id: string) =>
		notePageLoad(event(locals, id)) as Promise<{ canManage: boolean; role: string }>;

	it('H3 canManage per role', async () => {
		const { A, B, C, D, O, W1, CW, N } = await world();
		await shareWith(N.id, C.id, 'edit', A.id);
		expect((await load(localsFor(A, W1), N.id)).canManage).toBe(true);
		expect((await load(localsFor(D, W1), N.id)).canManage).toBe(true);
		expect((await load(localsFor(O, W1), N.id)).canManage).toBe(true);
		expect((await load(localsFor(B, W1), N.id)).canManage).toBe(false);
		const external = await load(localsFor(C, CW), N.id);
		expect(external).toMatchObject({ canManage: false, role: 'edit' });
	});

	it('H4 after the creator leaves: owner page loads with canManage, creator is locked out', async () => {
		const { A, O, W1, N } = await world();
		await removeMember(W1, A.id);
		expect((await load(localsFor(O, W1), N.id)).canManage).toBe(true);
		await expectStatus(load(localsFor(A, W1), N.id), 404);
	});
});
