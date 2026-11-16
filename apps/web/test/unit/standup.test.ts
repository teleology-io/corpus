import { describe, expect, it, vi } from 'vitest';
import { githubOutcome, linearOutcome } from '@corpus/core/integrations';
import {
	buildItems,
	MAX_ITEMS_PER_SECTION,
	prStatements,
	type IntegrationRow,
	type RawEvidence,
	type ReviewRow,
	type ThreadActivity
} from '../../src/lib/server/standup/build';
import { standupWindow } from '../../src/lib/server/standup/window';
import {
	defaultPlan,
	nextAfterLiquid,
	renderMarkdown,
	standupMessages,
	validatePlan,
	VISIBLE_PER_SECTION,
	type StandupItem,
	type StandupSnapshot
} from '../../src/lib/standup/model';
import { parseSetting, readSetting } from '../../src/lib/settings';
import { parseStandupDevicePrefs } from '../../src/lib/stores/standup-prefs';

vi.mock('@corpus/db', () => ({ env: (_: string, fallback: string) => fallback }));

// Tuesday 2026-11-17 in New York; window = Monday 00:00 → Tuesday 00:00 local.
const tz = 'America/New_York';
const from = new Date('2026-11-16T05:00:00Z');
const to = new Date('2026-11-17T05:00:00Z');
const todayEnd = new Date('2026-11-18T05:00:00Z');
const inWindow = '2026-11-16T18:00:00Z';
const before = '2026-11-10T18:00:00Z';

function raw(over: Partial<RawEvidence> = {}): RawEvidence {
	return {
		tz,
		window: { label: 'Yesterday', from, to, todayEnd },
		tasksDone: [],
		tasksOpen: [],
		events: [],
		workbench: null,
		items: [],
		reviews: [],
		coverage: [],
		...over
	};
}
const pr = (over: Partial<IntegrationRow> = {}): IntegrationRow => ({
	id: 'i1',
	provider: 'github',
	kind: 'pull_request',
	title: 'Add standup',
	subtitle: 'acme/app#12',
	url: 'https://github.com/acme/app/pull/12',
	state: 'review_required · success',
	payload: {},
	resolvedAt: null,
	...over
});
const review = (over: Partial<ReviewRow> = {}): ReviewRow => ({
	id: 'r1',
	itemId: 'i9',
	title: 'Fix login',
	subtitle: 'acme/api#7',
	url: 'https://github.com/acme/api/pull/7',
	status: 'findings',
	postedUrl: 'https://github.com/acme/api/pull/7#pullrequestreview-1',
	postedBy: 'me',
	accountLogin: 'me',
	findings: 2,
	updatedAt: inWindow,
	...over
});
const thread = (over: Partial<ThreadActivity> = {}): ThreadActivity => ({
	id: 'c1',
	title: 'Standup feature',
	workspaceId: 'w1',
	workspace: 'Main workspace',
	project: 'corpus',
	url: '/workbench?workspace=w1&tab=agents&chat=c1',
	turns: 3,
	failed: 0,
	lastStatus: 'done',
	lastAt: inWindow,
	prUrls: [],
	...over
});
const wb = (over: Partial<NonNullable<RawEvidence['workbench']>> = {}) => ({
	threads: [],
	commits: [],
	tasks: [],
	...over
});
const verbs = (items: StandupItem[]) => items.map((i) => `${i.section}:${i.verb}`);

describe('standup window', () => {
	it('covers yesterday on weekdays', () => {
		const w = standupWindow(tz, new Date('2026-11-17T14:00:00Z'));
		expect(w.label).toBe('Yesterday');
		expect(w.from.toISOString()).toBe('2026-11-16T05:00:00.000Z');
		expect(w.to.toISOString()).toBe('2026-11-17T05:00:00.000Z');
	});
	it('covers the previous Monday through Sunday on Mondays', () => {
		const w = standupWindow(tz, new Date('2026-11-16T14:00:00Z'));
		expect(w.label).toBe('Last week');
		expect(w.from.toISOString()).toBe('2026-11-09T05:00:00.000Z');
		expect(w.to.toISOString()).toBe('2026-11-16T05:00:00.000Z');
	});
	it('uses the local date, not UTC', () => {
		// 02:00 UTC Tuesday is still Monday evening in New York → a Monday standup.
		expect(standupWindow(tz, new Date('2026-11-17T02:00:00Z')).label).toBe('Last week');
	});
});

describe('evidence selection', () => {
	it('says "opened" only with a GitHub creation time inside the window', () => {
		const { items } = buildItems(
			raw({
				items: [
					pr({ id: 'a', url: 'u/a', payload: { createdAt: inWindow } }),
					pr({ id: 'b', url: 'u/b', payload: { createdAt: before } }),
					pr({ id: 'c', url: 'u/c', payload: {} })
				]
			})
		);
		expect(verbs(items)).toEqual(['past:opened_pr', 'today:pr_open', 'today:pr_open']);
	});

	it('uses provider outcomes for merged/closed and never infers them from the poll', () => {
		const { items } = buildItems(
			raw({
				items: [
					pr({
						id: 'm',
						url: 'u/m',
						resolvedAt: inWindow,
						payload: { outcome: 'merged', outcomeAt: inWindow }
					}),
					pr({
						id: 'x',
						url: 'u/x',
						resolvedAt: inWindow,
						payload: { outcome: 'closed', outcomeAt: inWindow }
					}),
					pr({ id: 'n', url: 'u/n', resolvedAt: inWindow, payload: {} }),
					pr({
						id: 'o',
						url: 'u/o',
						resolvedAt: inWindow,
						payload: { outcome: 'merged', outcomeAt: before }
					}),
					pr({
						id: 'u',
						url: 'u/u',
						resolvedAt: inWindow,
						payload: { outcome: 'open', outcomeAt: null }
					})
				]
			})
		);
		expect(verbs(items)).toEqual(['past:pr_merged', 'past:pr_closed', 'past:pr_no_longer_open']);
	});

	it('attributes a review only when GitHub authorship matches the connection', () => {
		const { items } = buildItems(
			raw({
				reviews: [
					review({ id: 'r1', postedUrl: 'p/1' }),
					review({ id: 'r2', postedUrl: 'p/2', postedBy: 'someone-else' }),
					review({ id: 'r3', postedUrl: 'p/3', postedBy: null }),
					review({ id: 'r4', postedUrl: null, url: 'u/r4' }),
					review({ id: 'r5', status: 'failed', url: 'u/r5', postedUrl: null })
				]
			})
		);
		expect(items.map((i) => i.verb)).toEqual([
			'reviewed_pr',
			'review_unverified',
			'review_unverified',
			'review_ran'
		]);
	});

	it('folds a thread into a PR only by exact PR URL, never by branch or workspace', () => {
		const url = 'https://github.com/acme/app/pull/12';
		const { items } = buildItems(
			raw({
				items: [pr({ payload: { createdAt: inWindow } })],
				workbench: wb({
					threads: [
						thread({ id: 'c1', url: '/t/1', prUrls: [url] }),
						thread({ id: 'c2', url: '/t/2', prUrls: ['https://github.com/acme/app/pull/1'] })
					]
				})
			})
		);
		expect(verbs(items)).toEqual(['past:opened_pr', 'past:thread_activity']);
		expect(items[0]!.related).toEqual([{ label: 'thread', url: '/t/1' }]);
	});

	it('describes thread activity, never completion', () => {
		const { items } = buildItems(
			raw({ workbench: wb({ threads: [thread({ lastStatus: 'failed' })] }) })
		);
		expect(items[0]!.verb).toBe('thread_activity');
		expect(items[0]!.statements.map((s) => s.text)).toContain('last turn failed');
	});

	it('groups commits per workspace and links to it', () => {
		const commit = (sha: string, subject: string, at: string) => ({
			sha,
			at,
			subject,
			workspaceId: 'w1',
			branch: 'master',
			workspace: 'Main',
			project: 'corpus',
			url: null,
			workspaceUrl: '/workbench?workspace=w1'
		});
		const { items } = buildItems(
			raw({
				workbench: wb({
					commits: [commit('a', 'first', '2026-11-16T10:00:00Z'), commit('b', 'second', inWindow)]
				})
			})
		);
		expect(items).toHaveLength(1);
		expect(items[0]!.verb).toBe('committed');
		expect(items[0]!.statements.map((s) => s.text)).toEqual(['2 commits', '“second”', '“first”']);
	});

	it('separates completed tasks from today’s work and keeps action descriptors inert', () => {
		const { items } = buildItems(
			raw({
				workbench: wb({
					tasks: [
						{
							id: 't1',
							title: 'Ship',
							status: 'done',
							createdAt: before,
							completedAt: inWindow,
							workspaceId: 'w1',
							workspace: 'Main',
							project: 'corpus'
						},
						{
							id: 't2',
							title: 'Write tests',
							status: 'todo',
							createdAt: before,
							completedAt: null,
							workspaceId: 'w1',
							workspace: 'Main',
							project: 'corpus'
						},
						{
							id: 't3',
							title: 'Old',
							status: 'done',
							createdAt: before,
							completedAt: before,
							workspaceId: 'w1',
							workspace: 'Main',
							project: 'corpus'
						}
					]
				})
			})
		);
		expect(verbs(items)).toEqual(['past:completed_task', 'today:task_todo']);
		expect(items[1]!.actions).toContainEqual({
			type: 'start_thread',
			workspaceId: 'w1',
			prompt: 'Write tests'
		});
	});

	it('reports items beyond the snapshot limit instead of dropping them silently', () => {
		const many = Array.from({ length: MAX_ITEMS_PER_SECTION + 5 }, (_, n) =>
			pr({ id: `p${n}`, url: `u/${n}`, kind: 'review_request' })
		);
		const { items, coverage } = buildItems(raw({ items: many }));
		expect(items).toHaveLength(MAX_ITEMS_PER_SECTION);
		expect(coverage.at(-1)).toMatchObject({ note: '5 more items not included' });
	});

	it('maps PR state to field-derived statements', () => {
		expect(prStatements('draft · changes_requested · failure', 'a/b#1').map((s) => s.text)).toEqual(
			['draft', 'changes requested', 'checks failing', 'a/b#1']
		);
	});
});

// ---------- rendering and validation over a fixed snapshot ----------

function snapshot(items: StandupItem[]): StandupSnapshot {
	return {
		v: 1,
		id: 's1',
		userId: 'u1',
		createdAt: from.toISOString(),
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
		timezone: tz,
		window: { label: 'Yesterday', from: from.toISOString(), to: to.toISOString() },
		items,
		coverage: []
	};
}
const item = (
	id: string,
	section: 'past' | 'today',
	over: Partial<StandupItem> = {}
): StandupItem => ({
	id,
	section,
	verb: section === 'past' ? 'completed_task' : 'task_todo',
	title: `Task ${id}`,
	url: `https://example.com/${id}`,
	at: null,
	source: { type: 'task', id },
	related: [],
	statements: [
		{ key: 'a', text: `fact a of ${id}` },
		{ key: 'b', text: `fact b of ${id}` }
	],
	actions: [],
	...over
});
const snap = snapshot([item('e1', 'past'), item('e2', 'past'), item('e3', 'today')]);
const ok = JSON.stringify({
	past: [
		{ id: 'e2', statements: ['b'] },
		{ id: 'e1', statements: [] }
	],
	today: [{ id: 'e3', statements: ['a'] }]
});

describe('validatePlan', () => {
	it('accepts a complete plan, including fenced JSON', () => {
		const v = validatePlan(snap, '```json\n' + ok + '\n```', 'verbose');
		expect(v.ok).toBe(true);
		if (v.ok) expect(v.plan.past.map((e) => e.id)).toEqual(['e2', 'e1']);
	});
	it.each([
		['not JSON', 'Sure! Here is your standup', 'not valid JSON'],
		['unknown id', ok.replace('"e3"', '"e9"'), 'Unknown id e9'],
		[
			'wrong section',
			JSON.stringify({
				past: [
					{ id: 'e1', statements: [] },
					{ id: 'e2', statements: [] },
					{ id: 'e3', statements: [] }
				],
				today: []
			}),
			'e3 is in past'
		],
		[
			'duplicate',
			JSON.stringify({
				past: [
					{ id: 'e1', statements: [] },
					{ id: 'e1', statements: [] },
					{ id: 'e2', statements: [] }
				],
				today: [{ id: 'e3', statements: [] }]
			}),
			'more than once'
		],
		[
			'missing item',
			JSON.stringify({
				past: [{ id: 'e1', statements: [] }],
				today: [{ id: 'e3', statements: [] }]
			}),
			'e2 is missing'
		],
		['foreign statement', ok.replace('["b"]', '["z"]'), 'cites statement "z"'],
		['too many statements', ok.replace('["b"]', '["a","b","a","b"]'), 'more than 3']
	])('rejects %s', (_, rawText, message) => {
		const v = validatePlan(snap, rawText, 'verbose');
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.errors.join(' | ')).toContain(message);
	});
	it('rejects statements in compact mode', () => {
		const v = validatePlan(snap, ok, 'compact');
		expect(v.ok).toBe(false);
	});
});

describe('renderMarkdown', () => {
	it('is complete even past the on-screen limit', () => {
		const many = snapshot(
			Array.from({ length: VISIBLE_PER_SECTION + 4 }, (_, n) => item(`e${n + 1}`, 'past'))
		);
		const md = renderMarkdown(many, defaultPlan(many, 'compact'));
		expect(md.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(
			VISIBLE_PER_SECTION + 4 + 1
		);
		expect(md).not.toContain('more');
	});
	it('builds compact and verbose from the same items; verbose only adds their statements', () => {
		const compact = defaultPlan(snap, 'compact');
		const verbose = defaultPlan(snap, 'verbose');
		const ids = (p: typeof compact) => [...p.past, ...p.today].map((e) => e.id);
		expect(ids(compact)).toEqual(ids(verbose));
		expect(renderMarkdown(snap, compact)).toBe(
			'## Yesterday\n- Completed task: [Task e1](https://example.com/e1)\n- Completed task: [Task e2](https://example.com/e2)\n\n## Today\n- To do: [Task e3](https://example.com/e3)'
		);
		expect(renderMarkdown(snap, verbose)).toContain(
			'- Completed task: [Task e1](https://example.com/e1) — fact a of e1; fact b of e1'
		);
	});
	it('escapes Markdown in titles and handles items without links', () => {
		const s = snapshot([
			item('e1', 'past', {
				title: 'Fix [prod] bug',
				url: null,
				related: [{ label: 'PR', url: 'https://x/(1)' }]
			})
		]);
		expect(renderMarkdown(s, defaultPlan(s, 'compact'))).toContain(
			'- Completed task: Fix \\[prod\\] bug ([PR](https://x/%281%29))'
		);
	});
	it('shows an empty section explicitly', () => {
		const s = snapshot([item('e1', 'today')]);
		expect(renderMarkdown(s, defaultPlan(s, 'compact'))).toContain(
			'## Yesterday\n- Nothing recorded'
		);
	});
});

describe('model prompt', () => {
	it('passes the detail explicitly and only exposes statements in verbose', () => {
		const c = standupMessages(snap, 'compact');
		const v = standupMessages(snap, 'verbose');
		expect(c.messages[0]!.content).toContain('Detail: compact');
		expect(v.messages[0]!.content).toContain('Detail: verbose');
		expect(c.messages[1]!.content).not.toContain('fact a');
		expect(v.messages[1]!.content).toContain('fact a of e1');
		expect(c.messages[1]!.content).not.toContain('https://');
	});
});

describe('fallback policy', () => {
	it('respects the device preference and Workbench access', () => {
		expect(nextAfterLiquid('auto', true)).toBe('hosted');
		expect(nextAfterLiquid('auto', false)).toBe('template');
		expect(nextAfterLiquid('liquid', true)).toBe('template');
	});
	it('defaults the device preference to auto', () => {
		expect(parseStandupDevicePrefs(null)).toEqual({ provider: 'auto' });
		expect(parseStandupDevicePrefs('{"provider":"hosted"}')).toEqual({ provider: 'hosted' });
		expect(parseStandupDevicePrefs('{"provider":"gpt"}')).toEqual({ provider: 'auto' });
	});
});

describe('settings registry', () => {
	it('defaults standup to off and compact', () => {
		expect(readSetting('standup.enabled', undefined)).toBe(false);
		expect(readSetting('standup.detail', undefined)).toBe('compact');
	});
	it('falls back to the default for a stored value that no longer validates', () => {
		expect(readSetting('standup.detail', 'chatty')).toBe('compact');
		expect(readSetting('standup.detail', 'verbose')).toBe('verbose');
	});
	it('rejects unknown keys and wrong types on write', () => {
		expect(() => parseSetting('standup.nope', true)).toThrow('Unknown setting');
		expect(() => parseSetting('standup.enabled', 'yes')).toThrow('Invalid value');
		expect(parseSetting('standup.enabled', true)).toEqual({ key: 'standup.enabled', value: true });
	});
});

describe('snapshot signing', () => {
	it('verifies, and rejects tampering, other users, expiry and oversize payloads', async () => {
		const { signSnapshot, verifySnapshot, MAX_SNAPSHOT_BYTES } =
			await import('../../src/lib/server/standup/sign');
		const s = signSnapshot(snap);
		expect(verifySnapshot('u1', s.payload, s.signature).ok).toBe(true);
		expect(
			verifySnapshot('u1', s.payload.replace('Task e1', 'Task eX'), s.signature)
		).toMatchObject({ status: 400 });
		expect(verifySnapshot('u2', s.payload, s.signature)).toMatchObject({ status: 403 });
		expect(verifySnapshot('u1', s.payload, s.signature, Date.now() + 120_000)).toMatchObject({
			status: 410
		});
		expect(verifySnapshot('u1', 'x'.repeat(MAX_SNAPSHOT_BYTES + 1), s.signature)).toMatchObject({
			status: 413
		});
	});
});

describe('provider outcomes', () => {
	it('maps GitHub and Linear states', () => {
		expect(githubOutcome({ id: '1', state: 'MERGED', mergedAt: 't' })).toEqual({
			outcome: 'merged',
			at: 't'
		});
		expect(githubOutcome({ id: '1', state: 'CLOSED', closedAt: 't' })).toEqual({
			outcome: 'closed',
			at: 't'
		});
		expect(
			githubOutcome({ id: '1', state: 'CLOSED', closedAt: 't', stateReason: 'COMPLETED' })
		).toEqual({ outcome: 'completed', at: 't' });
		expect(githubOutcome({ id: '1', state: 'OPEN' })).toEqual({ outcome: 'open', at: null });
		expect(githubOutcome({ id: '1' })).toBeNull();
		expect(linearOutcome({ id: '1', completedAt: 't', state: { type: 'completed' } })).toEqual({
			outcome: 'completed',
			at: 't'
		});
		expect(linearOutcome({ id: '1', canceledAt: 't', state: { type: 'canceled' } })).toEqual({
			outcome: 'canceled',
			at: 't'
		});
		expect(linearOutcome({ id: '1', state: { type: 'started' } })).toEqual({
			outcome: 'open',
			at: null
		});
	});
});
