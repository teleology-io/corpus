// Runs one reviewer CLI over a bundle, read-only, with a timeout. Knows nothing about the review.
import type { ChildProcess, SpawnOptions } from 'node:child_process';

export type ReviewProvider = 'claude' | 'codex';

export interface ReviewSlot {
	provider: ReviewProvider;
	model: string;
}

export interface AgentRun {
	text: string;
	costUsd: number;
	error: string | null;
}

export type Spawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export const AGENT_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Stays false until the sandbox spikes pass: docs don't settle whether Codex's read-only sandbox
 * blocks network access or reads across the disk, and these agents read hostile content.
 */
export const CODEX_ALLOWED_FOR_PR_REVIEW = false;

// Exact names, plus the prefixes the CLIs use for auth and config. Everything else stays behind,
// so server secrets such as DATABASE_URL can't reach an agent reading a stranger's PR, however
// they were set. Workbench's agentEnv only removes what Corpus's own .env loaded.
const ENV_NAMES = new Set(['HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'TMPDIR', 'PATH']);
const ENV_PREFIXES = ['LC_', 'ANTHROPIC_', 'CLAUDE_', 'CODEX_', 'OPENAI_', 'AWS_REGION'];

export function reviewEnv(env: Record<string, string | undefined>, searchPath?: string) {
	const clean: Record<string, string> = {};
	for (const [key, value] of Object.entries(env))
		if (value !== undefined && (ENV_NAMES.has(key) || ENV_PREFIXES.some((p) => key.startsWith(p))))
			clean[key] = value;
	if (searchPath) clean.PATH = searchPath;
	return clean;
}

/** Argument lists are built here rather than from agentArgs: these runs are always fresh and locked down. */
export function reviewArgs(slot: ReviewSlot) {
	const model = slot.model.trim();
	if (slot.provider === 'codex')
		return ['exec', '--sandbox', 'read-only', ...(model ? ['-m', model] : []), '--json', '-'];
	return [
		'--print',
		'--verbose',
		'--output-format',
		'stream-json',
		'--permission-mode',
		'plan',
		// User settings only: a .claude folder in the PR must never configure this run.
		'--setting-sources',
		'user',
		'--strict-mcp-config',
		'--allowedTools',
		'Read,Grep,Glob',
		'--disallowedTools',
		'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task',
		...(model ? ['--model', model] : [])
	];
}

const MAX_ACTION_LENGTH = 160;

/** A short line for one tool call, with bundle paths made relative. Untrusted: it can quote PR file names. */
export function describeTool(
	block: { name?: unknown; input?: unknown },
	cwd: string
): string | null {
	if (typeof block.name !== 'string') return null;
	const input = (block.input ?? {}) as Record<string, unknown>;
	const text = (value: unknown) =>
		typeof value === 'string' ? value.replaceAll(`${cwd}/tree/`, '').replaceAll(`${cwd}/`, '') : '';
	let action = block.name;
	if (block.name === 'Read') action = `Read ${text(input.file_path)}`;
	if (block.name === 'Glob') action = `Find ${text(input.pattern)}`;
	if (block.name === 'Grep') {
		const where = text(input.path);
		action = `Search "${text(input.pattern)}"${where ? ` in ${where}` : ''}`;
	}
	return action.trim().slice(0, MAX_ACTION_LENGTH);
}

/** Final text and cost from either CLI's JSON event stream. */
export function readEvent(
	line: string,
	state: { text: string; costUsd: number; error: string | null },
	onActivity?: (action: string | null) => void,
	cwd = ''
) {
	let data: {
		type?: string;
		subtype?: string;
		is_error?: boolean;
		result?: unknown;
		total_cost_usd?: number;
		parent_tool_use_id?: string | null;
		message?: unknown;
		error?: { message?: string };
		item?: { type?: string; text?: string };
	};
	try {
		data = JSON.parse(line);
	} catch {
		return;
	}
	const content = data.type === 'assistant' ? (data.message as { content?: unknown })?.content : [];
	const actions = (Array.isArray(content) ? content : [])
		.filter((block) => block?.type === 'tool_use')
		.map((block) => describeTool(block, cwd))
		.filter(Boolean);
	if (actions.length) for (const action of actions) onActivity?.(action);
	else onActivity?.(null);
	if (data.type === 'result') {
		if (typeof data.result === 'string') state.text = data.result;
		if (data.total_cost_usd) state.costUsd = data.total_cost_usd;
		if (data.is_error) state.error = String(data.result || 'Reviewer reported a failure');
	}
	if (data.type === 'item.completed' && data.item?.type === 'agent_message' && data.item.text)
		state.text = data.item.text;
	if (data.type === 'turn.failed' || data.type === 'error')
		state.error =
			data.error?.message || (typeof data.message === 'string' ? data.message : 'Reviewer failed');
}

export function runAgent(input: {
	slot: ReviewSlot;
	prompt: string;
	cwd: string;
	env: Record<string, string>;
	spawn: Spawn;
	timeoutMs?: number;
	onActivity?: (action: string | null) => void;
}): Promise<AgentRun> {
	return new Promise((resolve) => {
		const state = { text: '', costUsd: 0, error: null as string | null };
		let pending = '';
		let stderr = '';
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let child: ChildProcess;

		const settle = (error: string | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ text: state.text, costUsd: state.costUsd, error: error ?? state.error });
		};
		try {
			child = input.spawn(input.slot.provider, reviewArgs(input.slot), {
				cwd: input.cwd,
				env: input.env,
				detached: process.platform !== 'win32',
				stdio: ['pipe', 'pipe', 'pipe']
			});
		} catch (error) {
			settle((error as Error).message);
			return;
		}
		const kill = () => {
			try {
				if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
				else child.kill('SIGKILL');
			} catch {
				// Already gone.
			}
		};
		timer = setTimeout(() => {
			kill();
			settle(
				`Reviewer timed out after ${Math.round((input.timeoutMs ?? AGENT_TIMEOUT_MS) / 60000)} minutes`
			);
		}, input.timeoutMs ?? AGENT_TIMEOUT_MS);

		child.stdout?.setEncoding('utf8');
		child.stderr?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => {
			pending += chunk;
			const lines = pending.split('\n');
			pending = lines.pop() ?? '';
			for (const line of lines) readEvent(line, state, input.onActivity, input.cwd);
		});
		child.stderr?.on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-4000)));
		child.on('error', (error) => settle(error.message));
		child.on('close', (code) => {
			if (pending) readEvent(pending, state, input.onActivity, input.cwd);
			settle(
				code === 0 ? null : state.error || stderr.trim() || `Reviewer exited with code ${code}`
			);
		});
		child.stdin?.on('error', () => {});
		child.stdin?.end(input.prompt);
	});
}
