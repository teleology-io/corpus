import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvidenceGate } from '../../src/lib/standup/evidence-gate';
import type { StandupItem, StandupSnapshot } from '../../src/lib/standup/model';

const rw = vi.hoisted(() => ({
	rewriteSupported: vi.fn(async () => true),
	rewriteModelStored: vi.fn(async () => true),
	rewriteModelComplete: vi.fn(async () => true),
	startRewrite: vi.fn()
}));
const api = vi.hoisted(() => vi.fn());
vi.mock('#lib/components/notes/rewrite.js', () => rw);
vi.mock('#lib/api.js', () => ({ api }));

const { generateStandup } = await import('../../src/lib/standup/generate');

describe('evidence gate', () => {
	it('fetches once per opening and never retries a failure on its own', () => {
		const gate = createEvidenceGate();
		expect(gate.opened(true, null)).toBe(true);
		// The request failed: snapshot still missing, effect re-runs → no second request.
		expect(gate.opened(true, null)).toBe(false);
		expect(gate.opened(true, null)).toBe(false);
		// Closing and reopening tries again.
		expect(gate.opened(false, null)).toBe(false);
		expect(gate.opened(true, null)).toBe(true);
	});
	it('reuses a fresh snapshot and refetches an expired one', () => {
		const now = Date.parse('2026-11-16T12:00:00Z');
		expect(createEvidenceGate().opened(true, '2026-11-16T12:10:00Z', now)).toBe(false);
		expect(createEvidenceGate().opened(true, '2026-11-16T11:59:00Z', now)).toBe(true);
	});
});

const item: StandupItem = {
	id: 'e1',
	section: 'past',
	verb: 'completed_task',
	title: 'Ship it',
	url: null,
	at: null,
	source: { type: 'task', id: 't' },
	related: [],
	statements: [],
	actions: []
};
const snapshot: StandupSnapshot = {
	v: 1,
	id: 's',
	userId: 'u',
	createdAt: '2026-11-16T00:00:00Z',
	expiresAt: '2099-01-01T00:00:00Z',
	timezone: 'UTC',
	window: { label: 'Yesterday', from: '', to: '' },
	items: [
		item,
		{
			...item,
			id: 'e2',
			section: 'today',
			verb: 'issue_assigned',
			title: 'ENG-7',
			plan: 'off',
			group: 'ticket'
		}
	],
	coverage: []
};
const run = (pref: 'auto' | 'liquid' | 'hosted', hosted = true, selected: string[] = []) =>
	generateStandup({
		snapshot,
		signed: { payload: '{}', signature: 'sig', hosted: hosted ? { label: 'Hosted' } : null },
		detail: 'compact',
		pref,
		selected,
		onstatus: () => {}
	});

describe('generateStandup', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal('isSecureContext', true);
		rw.rewriteSupported.mockResolvedValue(true);
		rw.rewriteModelComplete.mockResolvedValue(true);
	});

	it('never starts Liquid on a partial model cache (no download)', async () => {
		rw.rewriteModelStored.mockResolvedValue(true);
		rw.rewriteModelComplete.mockResolvedValue(false);
		const r = await run('liquid');
		expect(rw.startRewrite).not.toHaveBeenCalled();
		expect(r.by).toBe('template');
		expect(r.note).toContain('only partly downloaded');
		expect(r.attempts[0]).toMatchObject({
			provider: 'liquid',
			outcome: 'unavailable',
			checks: { modelCacheExists: true, modelComplete: false }
		});
	});

	it('uses a valid Liquid plan', async () => {
		rw.startRewrite.mockImplementation((_m, _n, h) => {
			h.ontoken('{"past":[{"id":"e1","statements":[]}],"today":[]}');
			h.ondone();
			return { cancel() {} };
		});
		const r = await run('auto');
		expect(r.by).toBe('liquid');
		expect(api).not.toHaveBeenCalled();
	});

	it('falls back to hosted on invalid Liquid output, reusing the same signed snapshot', async () => {
		rw.startRewrite.mockImplementation((_m, _n, h) => {
			h.ontoken('Here is your standup!');
			h.ondone();
			return { cancel() {} };
		});
		api.mockResolvedValue({ ok: true, plan: { past: [{ id: 'e1', statements: [] }], today: [] } });
		const r = await run('auto');
		expect(api).toHaveBeenCalledWith('/api/standup', {
			body: { payload: '{}', signature: 'sig', detail: 'compact', selected: [] }
		});
		expect(r.by).toBe('hosted');
		expect(r.note).toContain('failed validation');
		expect(r.attempts.map((a) => `${a.provider}:${a.outcome}`)).toEqual([
			'liquid:invalid',
			'hosted:used'
		]);
		expect(r.attempts[0]!.output).toBe('Here is your standup!');
		expect(r.attempts[0]!.errors).toEqual(['Output is not valid JSON']);
	});

	it('treats a Liquid exception as a fallback, not a crash', async () => {
		rw.startRewrite.mockImplementation(() => {
			throw new Error('GPU lost');
		});
		const r = await run('liquid');
		expect(r.by).toBe('template');
		expect(r.note).toContain('GPU lost');
	});

	it('never goes hosted when the device says Liquid only, or without access', async () => {
		rw.rewriteSupported.mockResolvedValue(false);
		expect((await run('liquid')).by).toBe('template');
		expect((await run('auto', false)).by).toBe('template');
		expect((await run('hosted', false)).by).toBe('template');
		expect(api).not.toHaveBeenCalled();
	});

	it('reports a non-HTTPS page as the reason Liquid is off', async () => {
		vi.stubGlobal('isSecureContext', false);
		rw.rewriteSupported.mockResolvedValue(false);
		const r = await run('liquid');
		expect(r.attempts[0]!.reason).toContain('HTTPS or localhost');
		expect(r.attempts[0]!.checks).toMatchObject({ secureContext: false });
	});

	it('labels a failed hosted request as an error, not a validation failure', async () => {
		rw.rewriteSupported.mockResolvedValue(false);
		api.mockRejectedValue(new Error('Hosted generation needs Workbench access'));
		const r = await run('auto');
		expect(r.attempts.map((a) => `${a.provider}:${a.outcome}`)).toEqual([
			'liquid:unavailable',
			'hosted:error',
			'template:used'
		]);
		expect(r.note).toContain('hosted request failed');
	});

	it('writes Today only from picked items, for Liquid and for the hosted request', async () => {
		let prompt = '';
		rw.startRewrite.mockImplementation((m, _n, h) => {
			prompt = m[1].content;
			h.ontoken('nope');
			h.ondone();
			return { cancel() {} };
		});
		api.mockResolvedValue({ ok: false, errors: ['x'] });
		const unpicked = await run('auto', true, []);
		expect(prompt).not.toContain('ENG-7');
		expect(unpicked.markdown).not.toContain('ENG-7');
		expect(api.mock.calls[0]![1].body.selected).toEqual([]);
		const picked = await run('auto', true, ['e2']);
		expect(prompt).toContain('ENG-7');
		expect(picked.markdown).toContain('Issue due: ENG-7');
		expect(api.mock.calls[1]![1].body.selected).toEqual(['e2']);
	});

	it('falls back to the template when hosted output fails validation', async () => {
		api.mockResolvedValue({ ok: false, errors: ['e1 is missing'] });
		const r = await run('hosted');
		expect(r.by).toBe('template');
		expect(r.markdown).toContain('Completed task: Ship it');
	});
});
