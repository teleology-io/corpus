import { describe, expect, it } from 'vitest';
import {
	createProgress,
	progressReporter,
	progressView
} from '../../src/lib/server/pr-review/progress';
import { describeTool, readEvent } from '../../src/lib/server/pr-review/runner';
import {
	reviewPullRequest,
	DEFAULT_SLOTS,
	ROLES
} from '../../src/lib/server/pr-review/orchestrate';

const fresh = () => ({ text: '', costUsd: 0, error: null as string | null });
const clean = '```review-findings\n{"verdict":"clean","findings":[]}\n```';

describe('describeTool', () => {
	it('shows bundle paths relative to the code', () => {
		expect(describeTool({ name: 'Read', input: { file_path: '/b/tree/src/a.ts' } }, '/b')).toBe(
			'Read src/a.ts'
		);
		expect(describeTool({ name: 'Read', input: { file_path: '/b/pr.md' } }, '/b')).toBe(
			'Read pr.md'
		);
		expect(
			describeTool({ name: 'Grep', input: { pattern: 'lock', path: '/b/tree/src' } }, '/b')
		).toBe('Search "lock" in src');
		expect(describeTool({ name: 'Glob', input: { pattern: '**/*.ts' } }, '/b')).toBe(
			'Find **/*.ts'
		);
	});

	it('caps a long action', () => {
		const action = describeTool({ name: 'Glob', input: { pattern: 'x'.repeat(500) } }, '/b');
		expect(action!.length).toBeLessThanOrEqual(160);
	});
});

describe('readEvent activity', () => {
	it('reports each tool call', () => {
		const seen: (string | null)[] = [];
		const line = JSON.stringify({
			type: 'assistant',
			message: {
				content: [
					{ type: 'text', text: 'looking' },
					{ type: 'tool_use', name: 'Read', input: { file_path: '/b/tree/a.ts' } }
				]
			}
		});
		readEvent(line, fresh(), (action) => seen.push(action), '/b');
		expect(seen).toEqual(['Read a.ts']);
	});

	it('counts other events as a sign of life, but not unreadable lines', () => {
		const seen: (string | null)[] = [];
		readEvent('{"type":"system"}', fresh(), (action) => seen.push(action), '/b');
		readEvent('not json', fresh(), (action) => seen.push(action), '/b');
		expect(seen).toEqual([null]);
	});
});

describe('progress tracking', () => {
	it('tracks actions and quiet time', () => {
		let now = 1000;
		const progress = createProgress(ROLES, now);
		const report = progressReporter(progress, () => now);
		report.reviewer('integrator', 'working');
		now = 5000;
		report.activity('integrator', 'Read a.ts');
		now = 7000;
		report.activity('integrator', null);
		const view = progressView(progress, 10000);
		expect(view.elapsedSeconds).toBe(9);
		expect(view.reviewers[0]).toEqual({
			role: 'integrator',
			state: 'working',
			actions: 1,
			lastAction: 'Read a.ts',
			quietSeconds: 3
		});
		expect(view.reviewers[1].state).toBe('waiting');
	});

	it('follows a review through its stages, retries included', async () => {
		const progress = createProgress(ROLES);
		const report = progressReporter(progress);
		const seen: string[] = [];
		const attempts: Record<string, number> = {};
		await reviewPullRequest({
			slots: DEFAULT_SLOTS,
			bundleDir: '/b',
			treeState: 'merged',
			partial: false,
			headSha: 'h1',
			deps: {
				progress: report,
				currentHead: async () => 'h1',
				run: async (_slot, prompt, onActivity) => {
					const role = prompt.startsWith('You are the Integrator') ? 'integrator' : 'breaker';
					attempts[role] = (attempts[role] ?? 0) + 1;
					onActivity?.('Read a.ts');
					seen.push(`${role}:${progress.reviewers.find((r) => r.role === role)!.state}`);
					if (role === 'breaker' && attempts[role] === 1)
						return { text: '', costUsd: 0, error: 'boom' };
					return { text: clean, costUsd: 0, error: null };
				}
			}
		});
		expect(seen).toEqual(['integrator:working', 'breaker:working', 'breaker:retrying']);
		expect(progress.stage).toBe('reviewing');
		expect(progress.reviewers.map((r) => r.state)).toEqual(['done', 'done']);
		expect(progress.reviewers[1].actions).toBe(2);
	});

	it('marks a reviewer that never succeeds as failed', async () => {
		const progress = createProgress(ROLES);
		await reviewPullRequest({
			slots: DEFAULT_SLOTS,
			bundleDir: '/b',
			treeState: 'merged',
			partial: false,
			headSha: 'h1',
			deps: {
				progress: progressReporter(progress),
				currentHead: async () => 'h1',
				run: async () => ({ text: '', costUsd: 0, error: 'boom' })
			}
		});
		expect(progress.reviewers.map((r) => r.state)).toEqual(['failed', 'failed']);
	});

	it('moves to cross-checking when a reviewer finds a blocker', async () => {
		const progress = createProgress(ROLES);
		const stages: string[] = [];
		const blocker =
			'```review-findings\n' +
			JSON.stringify({
				verdict: 'findings',
				findings: [
					{
						id: 'x',
						severity: 'blocker',
						title: 'Bad',
						file: 'a.ts',
						line: 1,
						evidence: ['a.ts:1']
					}
				]
			}) +
			'\n```';
		await reviewPullRequest({
			slots: DEFAULT_SLOTS,
			bundleDir: '/b',
			treeState: 'merged',
			partial: false,
			headSha: 'h1',
			deps: {
				progress: progressReporter(progress),
				currentHead: async () => 'h1',
				run: async (_slot, prompt) => {
					stages.push(progress.stage);
					if (prompt.includes('Blockers to test'))
						return { text: '```review-crosscheck\n{"results":[]}\n```', costUsd: 0, error: null };
					return {
						text: prompt.startsWith('You are the Integrator') ? clean : blocker,
						costUsd: 0,
						error: null
					};
				}
			}
		});
		expect(stages).toEqual(['reviewing', 'reviewing', 'crosschecking']);
	});
});
