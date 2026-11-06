import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
	resolveSlots,
	reviewPullRequest,
	DEFAULT_SLOTS
} from '../../src/lib/server/pr-review/orchestrate';
import {
	reviewArgs,
	reviewEnv,
	runAgent,
	type AgentRun
} from '../../src/lib/server/pr-review/runner';

const fenced = (tag: string, value: unknown) =>
	'```' + tag + '\n' + JSON.stringify(value) + '\n```';
const clean = fenced('review-findings', { verdict: 'clean', findings: [] });
const blocker = (id: string) =>
	fenced('review-findings', {
		verdict: 'findings',
		findings: [
			{ id, severity: 'blocker', title: 'Bad', file: 'a.ts', line: 1, evidence: ['a.ts:1'] }
		]
	});

const ok = (text: string, costUsd = 1): AgentRun => ({ text, costUsd, error: null });

/** Answers by persona and round, and records how many times each ran. */
function agents(answers: Record<string, (attempt: number) => AgentRun>) {
	const calls: Record<string, number> = {};
	const run = async (_slot: unknown, prompt: string) => {
		const role = prompt.startsWith('You are the Integrator') ? 'integrator' : 'breaker';
		const key = prompt.includes('Blockers to test') ? `${role}-check` : role;
		calls[key] = (calls[key] ?? 0) + 1;
		return answers[key](calls[key]);
	};
	return { run, calls };
}

const review = (run: (s: never, p: string) => Promise<AgentRun>, over = {}) =>
	reviewPullRequest({
		slots: DEFAULT_SLOTS,
		bundleDir: '/b',
		treeState: 'merged',
		partial: false,
		headSha: 'h1',
		deps: { run: run as never, currentHead: async () => 'h1' },
		...over
	});

describe('reviewPullRequest', () => {
	it('is clean in two runs when nobody finds anything', async () => {
		const { run, calls } = agents({ integrator: () => ok(clean), breaker: () => ok(clean) });
		const out = await review(run);
		expect(out.status).toBe('clean');
		expect(out.costUsd).toBe(2);
		expect(calls).toEqual({ integrator: 1, breaker: 1 });
	});

	it('cross-examines only the other reviewer and drops on evidence', async () => {
		const { run, calls } = agents({
			integrator: () => ok(clean),
			breaker: () => ok(blocker('race')),
			'integrator-check': () =>
				ok(
					fenced('review-crosscheck', {
						results: [{ id: 'breaker:race', status: 'refuted', evidence: ['a.ts:9 lock'] }]
					})
				)
		});
		const out = await review(run);
		expect(calls['breaker-check']).toBeUndefined();
		expect(out.findings[0].dropped?.evidence).toEqual(['a.ts:9 lock']);
		expect(out.status).toBe('clean');
	});

	it('keeps a blocker as disputed when the cross-check itself fails', async () => {
		const { run } = agents({
			integrator: () => ok(clean),
			breaker: () => ok(blocker('race')),
			'integrator-check': () => ({ text: '', costUsd: 0, error: 'boom' })
		});
		const out = await review(run);
		expect(out.status).toBe('findings');
		expect(out.findings[0].disputed).toBe(true);
	});

	it('retries unusable output once and recovers', async () => {
		const { run, calls } = agents({
			integrator: (n) => ok(n === 1 ? 'no block here' : clean),
			breaker: () => ok(clean)
		});
		expect((await review(run)).status).toBe('clean');
		expect(calls.integrator).toBe(2);
	});

	it('fails rather than reading as clean when a reviewer never produces a result', async () => {
		const { run, calls } = agents({ integrator: () => ok('LGTM!'), breaker: () => ok(clean) });
		const out = await review(run);
		expect(out.status).toBe('failed');
		expect(out.error).toContain('integrator');
		expect(calls.integrator).toBe(2);
	});

	it('keeps the surviving reviewer findings on failure, untested', async () => {
		const { run, calls } = agents({
			integrator: () => ({ text: '', costUsd: 0, error: 'crashed' }),
			breaker: () => ok(blocker('race'))
		});
		const out = await review(run);
		expect(out.status).toBe('failed');
		expect(out.findings).toHaveLength(1);
		expect(calls['integrator-check']).toBeUndefined();
	});

	it('marks partial coverage and a moved head', async () => {
		const { run } = agents({ integrator: () => ok(clean), breaker: () => ok(clean) });
		expect((await review(run, { partial: true })).status).toBe('partial');
		const moved = { run: run as never, currentHead: async () => 'h2' };
		expect((await review(run, { deps: moved })).status).toBe('stale');
	});
});

describe('resolveSlots', () => {
	const claudeOnly = { claude: true, codex: false };
	const both = { claude: true, codex: true };

	it('gives a Claude-only machine two reviewers with a notice', () => {
		const out = resolveSlots(
			[
				{ provider: 'codex', model: 'x' },
				{ provider: 'claude', model: 'y' }
			],
			claudeOnly
		);
		expect(out.slots).toEqual([
			{ provider: 'claude', model: '' },
			{ provider: 'claude', model: 'y' }
		]);
		expect(out.notices[0]).toContain('not installed');
	});

	it('blocks Codex until the sandbox is verified, even when installed', () => {
		const out = resolveSlots([{ provider: 'codex', model: '' }, DEFAULT_SLOTS[1]], both);
		expect(out.slots?.[0].provider).toBe('claude');
		expect(out.notices[0]).toContain('not yet allowed');
	});

	it('honours Codex once allowed', () => {
		const out = resolveSlots([{ provider: 'codex', model: 'm' }, DEFAULT_SLOTS[1]], both, true);
		expect(out.slots?.[0]).toEqual({ provider: 'codex', model: 'm' });
		expect(out.notices).toEqual([]);
	});

	it('returns no slots when nothing can run', () => {
		expect(resolveSlots(undefined, { claude: false, codex: false }).slots).toBeNull();
		expect(resolveSlots(undefined, { claude: false, codex: true }).slots).toBeNull();
	});
});

describe('runner', () => {
	it('passes only allowlisted env, so server secrets stay behind', () => {
		const env = reviewEnv(
			{
				HOME: '/h',
				PATH: '/old',
				DATABASE_URL: 'postgres://secret',
				BETTER_AUTH_SECRET: 's',
				GITHUB_TOKEN: 'g',
				ANTHROPIC_API_KEY: 'a',
				CLAUDE_CONFIG_DIR: 'c'
			},
			'/new'
		);
		expect(env).toEqual({
			HOME: '/h',
			PATH: '/new',
			ANTHROPIC_API_KEY: 'a',
			CLAUDE_CONFIG_DIR: 'c'
		});
	});

	it('locks Claude down and never resumes a session', () => {
		const args = reviewArgs({ provider: 'claude', model: '' });
		expect(args).toContain('plan');
		expect(args[args.indexOf('--setting-sources') + 1]).toBe('user');
		expect(args[args.indexOf('--disallowedTools') + 1]).toContain('Bash');
		expect(args[args.indexOf('--disallowedTools') + 1]).toContain('WebFetch');
		expect(args).not.toContain('--resume');
		expect(args).not.toContain('bypassPermissions');
	});

	const fake = () => {
		const child = new EventEmitter() as unknown as ChildProcess;
		Object.assign(child, {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			stdin: new PassThrough(),
			kill: () => true
		});
		return child;
	};
	const start = (child: ChildProcess, timeoutMs?: number) =>
		runAgent({
			slot: { provider: 'claude', model: '' },
			prompt: 'p',
			cwd: '/b',
			env: {},
			spawn: () => child,
			timeoutMs
		});

	it('reads the result and cost', async () => {
		const child = fake();
		const done = start(child);
		child.stdout!.emit('data', '{"type":"result","result":"answer","total_cost_usd":0.5}\n');
		child.emit('close', 0);
		expect(await done).toEqual({ text: 'answer', costUsd: 0.5, error: null });
	});

	it('reports a non-zero exit and a provider error as failures', async () => {
		const exited = fake();
		const a = start(exited);
		exited.stderr!.emit('data', 'bad');
		exited.emit('close', 1);
		expect((await a).error).toBe('bad');

		const reported = fake();
		const b = start(reported);
		reported.stdout!.emit('data', '{"type":"result","is_error":true,"result":"limit"}\n');
		reported.emit('close', 0);
		expect((await b).error).toBe('limit');
	});

	it('times out rather than hanging', async () => {
		const out = await start(fake(), 5);
		expect(out.error).toContain('timed out');
	});

	it('surfaces a spawn failure', async () => {
		const out = await runAgent({
			slot: { provider: 'claude', model: '' },
			prompt: 'p',
			cwd: '/b',
			env: {},
			spawn: () => {
				throw new Error('ENOENT');
			}
		});
		expect(out.error).toBe('ENOENT');
	});
});
