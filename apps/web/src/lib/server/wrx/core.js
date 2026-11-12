/* eslint-disable @typescript-eslint/ban-ts-comment, no-empty, no-useless-escape -- verbatim WRX port */
// @ts-nocheck — ported verbatim from WRX (plain JS).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadedEnvKeys } from '@corpus/db/env';
import {
	Postgres,
	allocatePorts,
	applyPaths,
	assertEnvFileIgnored,
	baseDatabase,
	configCommands,
	readRepoConfig,
	renderEnv,
	runShell,
	slug as directorySlug,
	snapshotDatabase,
	startServices,
	workspaceDatabase,
	worktreesDirectory,
	writeEnvFile
} from './provision.js';
import { discoverCommands } from './discover.js';
import {
	commandLine,
	customTask,
	parseCommand,
	parseEnvLines,
	parseFlags,
	parseFolder,
	readLogTail,
	withFlags,
	withVirtualenv
} from './runner.js';
const exec = promisify(execFile);
const GIT_WORKTREE_TIMEOUT = 5 * 60000;
// Run tab: output goes to a file per run, since state is rewritten and pushed to clients on every change.
const RUN_LOG_LIMIT = 16 * 1024 * 1024;
const RUN_LOG_TAIL = 256 * 1024;
const RUNS_KEPT_PER_WORKSPACE = 20;
const PROMPT_COMMANDS = 30;
// How much of each new file the commit message writer gets to read.
const COMMIT_UNTRACKED_FILES = 40;
const COMMIT_UNTRACKED_BYTES = 512 * 1024;
const COMMIT_UNTRACKED_LINES = 60;
const composeProject = (w) => `wrx-${w.id.slice(0, 8)}`;
const variantKey = (taskId, variantId) => `${taskId}#${variantId}`;
const killGroup = (child, signal) => {
	try {
		process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);
	} catch {}
};
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export function requireText(value, name, max = 200) {
	if (typeof value !== 'string' || !value.trim() || value.length > max)
		throw new Error(`${name} is required (maximum ${max} characters)`);
	return value.trim();
}
export async function command(bin, args, options = {}) {
	const { stdout } = await exec(bin, args, {
		timeout: 15000,
		maxBuffer: 4 * 1024 * 1024,
		...options
	});
	return stdout.trim();
}
// A folder that isn't in a Git repository, or a computer without Git, can still be a project: it
// shows this branch name and has only its main workspace.
const FOLDER_BRANCH = 'master';
// The repository a folder is in, or null when it isn't in one. Any other failure, like Git refusing a
// repository owned by someone else, is an error, so a repository is never opened as a plain folder.
export async function repositoryRoot(directory) {
	try {
		return await command('git', ['-C', directory, 'rev-parse', '--show-toplevel']);
	} catch (error) {
		if (error.code === 'ENOENT' || /not a git repository/i.test(String(error.stderr))) return null;
		throw error;
	}
}
// Agent CLIs are often installed where a terminal or GUI launch doesn't put them on PATH (Codex ships
// inside the VS Code-family extensions). Agents always run with these locations appended.
const EDITOR_EXTENSIONS = [
	'.vscode/extensions',
	'.vscode-insiders/extensions',
	'.cursor/extensions',
	'.windsurf/extensions'
];
export function agentSearchPath(env = process.env, home = os.homedir()) {
	const dirs = (env.PATH || '').split(path.delimiter);
	dirs.push(
		path.join(home, '.local/bin'),
		path.join(home, '.npm-global/bin'),
		path.join(home, '.bun/bin'),
		path.join(home, '.volta/bin'),
		'/opt/homebrew/bin',
		'/usr/local/bin'
	);
	for (const folder of EDITOR_EXTENSIONS) {
		let names = [];
		try {
			names = fs
				.readdirSync(path.join(home, folder))
				.filter((n) => n.startsWith('openai.chatgpt-'));
		} catch {}
		for (const name of names.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
			// newest extension first
			const bin = path.join(home, folder, name, 'bin');
			try {
				for (const platform of fs.readdirSync(bin)) dirs.push(path.join(bin, platform));
			} catch {}
		}
	}
	return [...new Set(dirs.filter(Boolean))];
}
// A .env can name these for its own reasons; removing them would break any process that runs.
const HOST_ENV = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'TMPDIR']);
// The server's env minus what Corpus's own .env added, for processes working on other repositories.
export function hostEnv(env = process.env) {
	const clean = { ...env };
	for (const key of loadedEnvKeys()) if (!HOST_ENV.has(key)) delete clean[key];
	return clean;
}
export const agentEnv = (env = process.env) => {
	const clean = hostEnv(env);
	return { ...clean, PATH: agentSearchPath(clean).join(path.delimiter) };
};
const missingCli = (provider) =>
	provider === 'codex'
		? 'Codex CLI not found on this computer. Install it (npm install -g @openai/codex) or the Codex editor extension, then try again. Connections shows what Workbench can find.'
		: 'Claude Code CLI not found on this computer. Install it (see claude.com/claude-code), run claude auth login, then try again.';
export function dockerEnv(profile) {
	const env = hostEnv();
	delete env.DOCKER_CONTEXT;
	delete env.DOCKER_HOST;
	env.DOCKER_HOST = `unix://${path.join(os.homedir(), '.colima', profile, 'docker.sock')}`;
	return env;
}
export const MODES = ['assess', 'implement', 'review'];
const MAX_HOPS = 6;
const RESERVED = new Set(['you', 'all', 'here', 'channel', 'everyone', 'user', 'human', 'wrx']);
const EVERYONE = new Set(['all', 'here', 'channel', 'everyone']);
const MODE_PROMPTS = {
	assess:
		'Mode: advise and plan (read-only). You may inspect the workspace but must not modify files. Clarify intent, surface risks and ambiguities, and propose concrete next steps.',
	implement:
		'Mode: implement. You may edit workspace files. Inspect existing code first, make the change, run relevant validation, and report what changed and any risks.',
	review:
		'Mode: review (read-only). Do not modify files. Prioritize concrete bugs, regressions, gaps and actionable findings with file references.'
};
const slug = (value) =>
	String(value)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 24) || 'agent';
const clip = (text, max = 4000) => {
	text = String(text ?? '');
	return text.length > max
		? `${text.slice(0, max)}\n… (${text.length - max} more characters)`
		: text;
};
const resultText = (content) =>
	typeof content === 'string'
		? content
		: Array.isArray(content)
			? content
					.map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : ''))
					.join('\n')
			: JSON.stringify(content ?? '');
// @handles outside code spans, lowercased, in order of appearance
export function mentions(text) {
	const plain = String(text || '')
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/`[^`\n]*`/g, ' ');
	return [...plain.matchAll(/(^|[^\w@/.`])@([a-z0-9][a-z0-9_-]*)/gi)].map((m) =>
		m[2].replace(/[-_]+$/, '').toLowerCase()
	);
}
export function toolSummary(name, input = {}, root = '') {
	const rel = (p) =>
		root && String(p).startsWith(`${root}/`) ? String(p).slice(root.length + 1) : String(p ?? '');
	const value =
		(input?.file_path ?? input?.notebook_path)
			? rel(input.file_path ?? input.notebook_path)
			: (input?.command ??
				input?.pattern ??
				input?.url ??
				input?.query ??
				input?.description ??
				(Array.isArray(input?.changes)
					? input.changes.map((c) => `${c.kind ?? 'update'} ${rel(c.path)}`).join(', ')
					: null) ??
				(Array.isArray(input?.todos) ? `${input.todos.length} items` : null) ??
				Object.values(input || {}).find((v) => typeof v === 'string'));
	return String(value ?? '')
		.replace(/\s+/g, ' ')
		.slice(0, 200);
}
export function toolDetail(name, input = {}) {
	if (!input || typeof input !== 'object') return '';
	const lines = (prefix, text) =>
		String(text ?? '')
			.split('\n')
			.map((l) => prefix + l)
			.join('\n');
	if (name === 'Edit')
		return clip(
			input.changes ? '' : `${lines('-', input.old_string)}\n${lines('+', input.new_string)}`
		);
	if (name === 'MultiEdit')
		return clip(
			(input.edits || [])
				.map((e) => `${lines('-', e.old_string)}\n${lines('+', e.new_string)}`)
				.join('\n@@\n')
		);
	if (name === 'Write') return clip(lines('+', input.content));
	if (name === 'Bash') return clip(input.command);
	if (name === 'TodoWrite' || name === 'Read' || name === 'Glob') return '';
	return clip(JSON.stringify(input, null, 2), 2000);
}
export const IMAGE_TYPES = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp'
};
export const MAX_IMAGES = 6;
// Any other file the human attaches is saved next to the thread's images under its own name and
// handed to agents as an absolute path to read with their tools.
export const MAX_ATTACHMENTS = 10;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export function safeFileName(name, fallback) {
	const clean = String(name || '')
		.replace(/[\/\\]/g, '_')
		.replace(/[^\w.\- ()+@,]/g, '_')
		.replace(/^\.+/, '')
		.trim()
		.slice(0, 120);
	return clean || fallback;
}
// Long threads: a member's provider session grows with every turn (tool calls, file reads), which
// slows each resume. After ROTATE_TURNS turns the session is dropped and the next turn starts fresh
// from the thread summary plus the last RECENT_WITH_SUMMARY messages.
export const ROTATE_TURNS = 25;
const RECENT_WITH_SUMMARY = 6;
const RECENT_WITHOUT_SUMMARY = 30;
// A fresh start in a thread longer than this refreshes the summary first.
const SUMMARY_AFTER = 30;
const SUMMARY_INPUT_CHARS = 60000;
const SUMMARY_TIMEOUT_MS = 3 * 60000;
export function summaryPrompt(previous, transcript) {
	return [
		'You maintain the running summary of a Workbench team thread: a chat where a human (@you) works with AI agents on a software project. Agents joining or resuming the thread read this summary instead of the full history.',
		previous ? `Current summary:\n${previous}` : 'There is no summary yet.',
		`Messages to fold in:\n${transcript}`,
		'Write the updated summary. Keep: the goal, decisions made and why, what was built or changed (files, features), open questions, outstanding tasks and who owns them, and any preferences or constraints the human stated. Drop chit-chat and superseded details. Use terse Markdown bullets under short headings, at most about 500 words. Reply with the summary only.'
	].join('\n\n');
}
// One-shot, tool-free run of the member's provider CLI that only writes text.
export function summaryArgs(provider) {
	return provider === 'codex'
		? ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '-']
		: ['--print', '--model', 'haiku', '--permission-mode', 'plan', '--output-format', 'text'];
}
// Thread view for the client: the open chat's latest `limit` messages, and only a one-line preview of
// every other chat. Shipping every message of every thread on each streaming refresh was the cost.
export function clientChats(chats, open, limit = 60) {
	return chats.map((c) => {
		const { messages, events, summary, summaryUpTo, ...rest } = c;
		if (c.id === open)
			return {
				...rest,
				events,
				hasSummary: !!summary,
				messageCount: messages.length,
				messages: messages.slice(-Math.max(1, limit))
			};
		const last = messages.findLast((m) => m.role !== 'system' && m.text);
		return {
			...rest,
			events: [],
			partial: true,
			messageCount: messages.length,
			messages: last
				? [
						{
							id: last.id,
							role: last.role,
							memberId: last.memberId,
							text: last.text.slice(0, 200),
							at: last.at
						}
					]
				: []
		};
	});
}
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const GENERATED_EXT = {
	'.png': 'png',
	'.jpg': 'jpg',
	'.jpeg': 'jpg',
	'.gif': 'gif',
	'.webp': 'webp'
};
const GENERATED_TYPES = {
	png: 'image/png',
	jpg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp'
};
// Codex's built-in image tool writes $CODEX_HOME/generated_images/<session>/ig_*.png and does not
// report the file in `exec --json`, so turns look there for images created since they started.
export function codexGeneratedImages(sessionId, since, env = process.env) {
	if (!sessionId || /[\/\\]|\.\./.test(sessionId)) return [];
	const dir = path.join(
		env.CODEX_HOME || path.join(os.homedir(), '.codex'),
		'generated_images',
		sessionId
	);
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	return names
		.filter((n) => GENERATED_EXT[path.extname(n).toLowerCase()])
		.map((n) => ({ name: n, path: path.join(dir, n), stat: fs.statSync(path.join(dir, n)) }))
		.filter(
			(f) => f.stat.isFile() && f.stat.mtimeMs >= since - 2000 && f.stat.size <= 25 * 1024 * 1024
		)
		.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs)
		.slice(-8);
}
// Images reach Codex as --image files and Claude as image blocks on stream-json input. Claude runs
// as one long-lived process per thread member that takes each turn as a stream-json line on stdin.
export function agentArgs(agent, images = [], dirs = []) {
	const model = agent.model?.trim();
	if (agent.provider === 'codex')
		return [
			'exec',
			// Codex otherwise refuses a project folder that isn't a Git repository.
			'--skip-git-repo-check',
			...(agent.sessionId
				? ['resume', agent.sessionId]
				: [
						'--sandbox',
						agent.fullAccess
							? 'danger-full-access'
							: agent.mode === 'implement'
								? 'workspace-write'
								: 'read-only',
						...(model ? ['-m', model] : [])
					]),
			...images.flatMap((i) => ['--image', i.path]),
			'--json',
			'-'
		];
	return [
		'--print',
		'--verbose',
		'--output-format',
		'stream-json',
		'--input-format',
		'stream-json',
		'--permission-mode',
		// acceptEdits only auto-approves file edits; headless runs deny Bash, web and MCP
		// tools. Full access bypasses every permission prompt.
		agent.fullAccess ? 'bypassPermissions' : agent.mode === 'implement' ? 'acceptEdits' : 'plan',
		...(model ? ['--model', model] : []),
		...(agent.sessionId ? ['--resume', agent.sessionId] : []),
		// Lets Claude read attached files kept outside the workspace.
		...dirs.flatMap((d) => ['--add-dir', d])
	];
}
export function agentInput(agent, prompt, images = []) {
	if (agent.provider === 'codex') return prompt;
	const content = [
		{ type: 'text', text: prompt },
		...images.map((i) => ({
			type: 'image',
			source: {
				type: 'base64',
				media_type: i.type,
				data: fs.readFileSync(i.path).toString('base64')
			}
		}))
	];
	return `${JSON.stringify({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: agent.sessionId || '' })}\n`;
}
// Older single-agent chats become one-member threads; live state from a previous run is cleared.
function migrateChat(c) {
	if (!c.members) {
		const provider = c.provider === 'codex' ? 'codex' : 'claude';
		const m = {
			id: id(),
			name: provider === 'codex' ? 'Codex' : 'Claude',
			handle: provider,
			role: '',
			provider,
			mode: MODES.includes(c.mode) ? c.mode : 'assess',
			model: '',
			color: 0,
			sessionId: c.sessionId || null,
			status: 'idle',
			seen: c.messages.length,
			costUsd: 0,
			createdAt: c.createdAt
		};
		for (const msg of c.messages)
			if (msg.role === 'assistant')
				Object.assign(msg, { role: 'agent', memberId: m.id, status: 'done' });
		Object.assign(c, { members: [m], leadId: m.id, maxHops: MAX_HOPS });
		delete c.provider;
		delete c.mode;
		delete c.sessionId;
		delete c.reports;
		delete c.parentId;
	}
	for (const msg of c.messages) {
		msg.id ||= id();
		if (msg.status === 'running') msg.status = 'interrupted';
	}
	for (const m of c.members) {
		m.status = 'idle';
		m.live = false;
	}
	delete c.summarizing;
	if (c.status === 'running' || c.status === 'queued') {
		c.status = 'interrupted';
		c.messages.push({
			id: id(),
			role: 'system',
			text: 'Workbench restarted during this turn. Send a follow-up to continue.',
			at: now()
		});
	}
}
export class Store {
	constructor(directory) {
		this.directory = directory;
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		this.file = path.join(directory, 'state.json');
		this.state = fs.existsSync(this.file)
			? JSON.parse(fs.readFileSync(this.file, 'utf8'))
			: { projects: [], workspaces: [], environments: [], chats: [], tasks: [] };
		for (const c of this.state.chats) migrateChat(c);
		for (const e of this.state.environments)
			if (e.busy) {
				e.busy = false;
				e.status = 'unknown';
			}
		// Background setup doesn't survive a restart. Its steps are idempotent, so Retry resumes it.
		for (const w of this.state.workspaces) {
			if (w.provision?.status === 'running') {
				w.provision.status = 'failed';
				w.provision.error = 'Workbench restarted during setup';
			}
			if (w.database?.busy) {
				w.database.busy = false;
				w.database.error = 'Workbench restarted during this operation';
			}
		}
		// The server's exit stops these, but a crash can leave one behind. Its PID may have been reused
		// since, so it's never signalled from here.
		this.state.commandRuns ??= [];
		for (const r of this.state.commandRuns)
			if (r.status === 'running') {
				r.status = 'interrupted';
				r.error = 'Workbench restarted during this run';
				r.finishedAt = now();
			}
		this.save();
	}
	save() {
		const tmp = `${this.file}.tmp`;
		// Compact: this runs on every flush during a streaming turn, and long threads make it large.
		fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
		fs.renameSync(tmp, this.file);
	}
	get(kind, key) {
		const item = this.state[kind].find((x) => x.id === key);
		if (!item) throw new Error(`${kind} entry not found`);
		return item;
	}
}
const CHANGE_FLUSH_MS = 150;
export class Engine {
	constructor(store, publish = () => {}, spawnProcess = spawn) {
		this.store = store;
		this.publish = publish;
		this.spawn = spawnProcess;
		this.running = new Map();
		// Live Claude processes by `${chatId}:${memberId}`. They outlive a turn so background tasks
		// (Monitor, background Bash) keep running and can wake the agent between turns.
		this.sessions = new Map();
		this.commandChildren = new Map();
		this.queue = [];
	}
	// Agent runs call this for every output line. Coalesce into one disk write + one client
	// notification per CHANGE_FLUSH_MS so a streaming run doesn't block the event loop with
	// a full pretty-printed state write per line. State in memory stays authoritative.
	changed() {
		if (this.changeTimer) return;
		if (!this.exitFlush) {
			this.exitFlush = () => this.flushChanges();
			process.once('exit', this.exitFlush);
		}
		this.changeTimer = setTimeout(() => this.flushChanges(), CHANGE_FLUSH_MS);
	}
	flushChanges() {
		if (!this.changeTimer) return;
		clearTimeout(this.changeTimer);
		this.changeTimer = null;
		this.store.save();
		this.publish();
	}
	async project(input) {
		const directory = fs.realpathSync(
			requireText(input.path, 'Repository path', 4096).replace(/^~(?=\/)/, os.homedir())
		);
		if (!fs.statSync(directory).isDirectory()) throw new Error('Select a directory');
		const repository = await repositoryRoot(directory);
		const root = repository ?? directory;
		if (this.store.state.projects.some((p) => p.path === root))
			throw new Error(`This ${repository ? 'repository' : 'folder'} is already registered`);
		const branch = repository
			? await command('git', ['-C', root, 'branch', '--show-current'])
			: FOLDER_BRANCH;
		const project = {
			id: id(),
			name: input.name?.trim() || path.basename(root),
			path: root,
			// The UI leaves out what needs Git, worktrees or project tooling.
			...(repository ? {} : { folder: true }),
			createdAt: now()
		};
		const workspace = {
			id: id(),
			projectId: project.id,
			name: 'Main workspace',
			branch: branch || 'detached HEAD',
			path: root,
			environmentId: null,
			createdAt: now()
		};
		this.store.state.projects.push(project);
		this.store.state.workspaces.push(workspace);
		this.changed();
		return project;
	}
	async workspace(input) {
		const project = this.store.get('projects', input.projectId);
		const name = requireText(input.name, 'Workspace name');
		const branch = requireText(input.branch, 'Branch');
		const base = input.base ? requireText(input.base, 'Base branch') : 'HEAD';
		if (base.startsWith('-')) throw new Error('Invalid base branch');
		if (input.seed && !['clone', 'blank'].includes(input.seed))
			throw new Error('Invalid database seed');
		if (input.environmentId) {
			const e = this.store.get('environments', input.environmentId);
			if (e.scope !== 'shared') throw new Error('Only shared environments can be reused');
		}
		if (!(await repositoryRoot(project.path)))
			throw new Error(
				"New workspaces are Git worktrees, and this folder isn't a Git repository. It has its main workspace only."
			);
		await command('git', ['check-ref-format', '--branch', branch]);
		if (branch.startsWith('-')) throw new Error('Invalid branch');
		const existing = !!input.existingBranch;
		const ref = existing ? `refs/heads/${branch}` : base;
		await command('git', ['-C', project.path, 'rev-parse', '--verify', `${ref}^{commit}`]);
		const repoConfig = await readRepoConfig(project.path, ref, agentEnv());
		if (repoConfig && project.trustedConfigHash !== repoConfig.hash) {
			if (input.trustConfigHash !== repoConfig.hash)
				throw new Error(
					`Approve this repository's .workbench.json before it runs on this computer`
				);
			project.trustedConfigHash = repoConfig.hash;
		}
		const wid = id();
		const directory = path.join(
			worktreesDirectory(project),
			`${directorySlug(name)}-${wid.slice(0, 8)}`
		);
		fs.mkdirSync(path.dirname(directory), { recursive: true });
		await command(
			'git',
			[
				'-C',
				project.path,
				'worktree',
				'add',
				...(existing ? [directory, branch] : ['-b', branch, directory, base])
			],
			{ timeout: GIT_WORKTREE_TIMEOUT, env: agentEnv() }
		);
		const workspace = {
			id: wid,
			projectId: project.id,
			name,
			branch,
			base: existing ? branch : base,
			path: directory,
			environmentId: null,
			createdAt: now()
		};
		if (repoConfig)
			// The approved config is kept: an agent editing its checkout's copy can't change what a later
			// Retry or teardown runs on the host.
			workspace.provision = {
				status: 'running',
				step: 'Starting',
				log: '',
				error: null,
				config: repoConfig.config,
				seed: input.seed || repoConfig.config.database?.seed || null,
				slot: null,
				ports: {},
				env: {}
			};
		if (input.environmentId) {
			this.store.get('environments', input.environmentId);
			workspace.environmentId = input.environmentId;
		}
		if (input.isolated) {
			const env = this.environment({
				name: `${project.name} / ${name}`,
				scope: 'isolated',
				workspaceId: wid
			});
			workspace.environmentId = env.id;
		}
		this.store.state.workspaces.push(workspace);
		this.changed();
		if (workspace.provision) void this.provisionWorkspace(workspace);
		return workspace;
	}
	// The config a workspace would run, and whether it still needs approval, before anything is created.
	async workspaceConfig(input) {
		const project = this.store.get('projects', input.projectId);
		const ref = input.existingBranch
			? `refs/heads/${requireText(input.branch, 'Branch')}`
			: requireText(input.base || 'HEAD', 'Base branch');
		if (ref.startsWith('-')) throw new Error('Invalid base branch');
		const found = await readRepoConfig(project.path, ref, agentEnv());
		if (!found) return { found: false };
		return {
			found: true,
			hash: found.hash,
			trusted: project.trustedConfigHash === found.hash,
			commands: configCommands(found.config),
			hasDatabase: !!found.config.database,
			seed: found.config.database?.seed || null
		};
	}
	// Serializes work that would race: port allocation, and copies of one project's template.
	locked(key, work) {
		this.locks ??= new Map();
		const next = (this.locks.get(key) || Promise.resolve()).catch(() => {}).then(work);
		this.locks.set(key, next);
		return next;
	}
	// Env for scripts a workspace's config runs, so they can find each other's checkouts and ports.
	scriptEnv(w, project) {
		return {
			...agentEnv(),
			...w.provision.env,
			WORKBENCH_WORKSPACE_PATH: w.path,
			WORKBENCH_PRIMARY_PATH: project.path,
			WORKBENCH_BRANCH: w.branch,
			WORKBENCH_SLOT: String(w.provision.slot ?? '')
		};
	}
	provisionLog(w) {
		return (text) => {
			w.provision.log = (w.provision.log + text).slice(-80000);
			this.changed();
		};
	}
	postgres(w, project) {
		return new Postgres(w.provision.config, project.path, {
			log: this.provisionLog(w),
			env: agentEnv()
		});
	}
	async provisionWorkspace(w) {
		const p = w.provision;
		const project = this.store.get('projects', w.projectId);
		const { config } = p;
		const log = this.provisionLog(w);
		const step = (name) => {
			p.step = name;
			log(`\n== ${name}\n`);
		};
		p.status = 'running';
		p.error = null;
		try {
			const env = agentEnv();
			step('Copying files');
			await applyPaths(config, project.path, w.path, { log, env });
			const portNames = Object.keys(config.ports);
			if (portNames.length && p.slot === null) {
				step('Allocating ports');
				await this.locked('ports', async () => {
					const taken = this.store.state.workspaces
						.map((x) => x.provision?.slot)
						.filter((slot) => slot !== null && slot !== undefined);
					const { slot, ports } = await allocatePorts(portNames, taken);
					p.slot = slot;
					p.ports = ports;
				});
			}
			if (config.services.shared.length) {
				step('Starting services');
				await startServices(config, project.path, { log, env });
			}
			let databaseUrl = '';
			if (config.database) {
				step('Creating database');
				databaseUrl = await this.ensureDatabase(w, project);
			}
			p.env = renderEnv(config, { ports: p.ports, databaseUrl, workspace: w });
			if (config.envFile) {
				step('Writing env file');
				await assertEnvFileIgnored(w.path, config.envFile, env);
				writeEnvFile(path.join(w.path, config.envFile), p.env);
			}
			const scripted = this.scriptEnv(w, project);
			if (config.scripts.setup) {
				step('Running setup');
				await runShell(config.scripts.setup, { cwd: w.path, env: scripted, log });
			}
			if (config.database?.migrate) {
				step('Running migrations');
				await runShell(config.database.migrate, { cwd: w.path, env: scripted, log });
			}
			p.step = 'Ready';
			p.status = 'ready';
			log('\nReady.\n');
		} catch (error) {
			p.status = 'failed';
			p.error = error.message;
			log(`\n${error.message}\n`);
		}
		this.changed();
		this.pump();
	}
	async ensureDatabase(w, project) {
		const { config, seed } = w.provision;
		const pg = this.postgres(w, project);
		const name = workspaceDatabase(w.id);
		w.database ??= { name, snapshots: [], nextSnapshot: 1, busy: false, error: null };
		project.database = { database: config.database, services: config.services };
		await this.locked(`db:${project.id}`, async () => {
			if (await pg.exists(name)) return;
			await this.createFromSeed(pg, project, name, seed);
		});
		return pg.urlFor(name);
	}
	async createFromSeed(pg, project, name, seed) {
		if (seed === 'blank') return pg.createEmpty(name);
		const base = baseDatabase(project.id);
		if (!(await pg.exists(base))) await pg.buildBase(base);
		await pg.clone(base, name);
	}
	retryProvision(workspaceId) {
		const w = this.store.get('workspaces', workspaceId);
		if (w.provision?.status !== 'failed')
			throw new Error('This workspace has no failed setup to retry');
		void this.provisionWorkspace(w);
		return {};
	}
	// Snapshot, restore, reset and refresh-base all disconnect the workspace's apps, so agents wait.
	databaseAction(workspaceId, action, snapshot) {
		const w = this.store.get('workspaces', workspaceId);
		const project = this.store.get('projects', w.projectId);
		if (!w.database) throw new Error('This workspace has no database');
		if (w.database.busy) throw new Error('A database operation is already running');
		if (w.provision.status === 'running') throw new Error('Workspace setup is still running');
		if (this.store.state.chats.some((c) => c.workspaceId === w.id && this.chatRunning(c.id)))
			throw new Error('Stop running agents in this workspace first');
		const pg = this.postgres(w, project);
		const db = w.database;
		const log = this.provisionLog(w);
		const base = baseDatabase(project.id);
		const operations = {
			snapshot: async () => {
				const name = snapshotDatabase(w.id, db.nextSnapshot);
				await pg.cloneLive(db.name, name);
				await pg.allowConnections(name, false);
				db.nextSnapshot += 1;
				db.snapshots.push({ name, createdAt: now() });
			},
			restore: async () => {
				if (!db.snapshots.some((s) => s.name === snapshot)) throw new Error('Snapshot not found');
				await pg.drop(db.name);
				await pg.clone(snapshot, db.name);
			},
			reset: async () => {
				await pg.drop(db.name);
				await this.createFromSeed(pg, project, db.name, w.provision.seed);
				const { migrate } = w.provision.config.database;
				if (migrate) await runShell(migrate, { cwd: w.path, env: this.scriptEnv(w, project), log });
			},
			'refresh-base': () => pg.buildBase(base)
		};
		const operation = operations[action];
		if (!operation) throw new Error('Unknown database action');
		db.busy = true;
		db.error = null;
		log(`\n== Database: ${action}\n`);
		this.changed();
		void this.locked(`db:${project.id}`, operation)
			.catch((error) => {
				db.error = error.message;
				log(`\n${error.message}\n`);
			})
			.finally(() => {
				db.busy = false;
				this.changed();
				this.pump();
			});
		return {};
	}
	assertRemovable(w) {
		if (this.store.state.chats.some((c) => c.workspaceId === w.id && this.chatRunning(c.id)))
			throw new Error('Stop running agents in this workspace first');
		if (this.store.state.commandRuns.some((r) => r.workspaceId === w.id && r.status === 'running'))
			throw new Error('Stop running commands in this workspace first');
		if (w.provision?.status === 'running') throw new Error(`"${w.name}" is still being set up`);
		if (w.database?.busy) throw new Error(`"${w.name}" has a database operation running`);
		const e = w.environmentId && this.store.get('environments', w.environmentId);
		if (e?.busy) throw new Error(`Environment "${e.name}" is busy`);
	}
	async assertClean(w) {
		if (!fs.existsSync(w.path)) return;
		if (await command('git', ['status', '--porcelain'], { cwd: w.path }).catch(() => ''))
			throw new Error(
				`Workspace "${w.name}" has uncommitted changes. Commit or discard them first.`
			);
	}
	// Removes a VM and its data disk. Never-started environments have nothing on this computer.
	async destroyVm(e) {
		if (e.status === 'not provisioned') return;
		await command('colima', ['--profile', e.profile, 'delete', '--force', '--data'], {
			timeout: GIT_WORKTREE_TIMEOUT,
			env: agentEnv()
		});
	}
	// Removes what a workspace owns outside Workbench's state. A failed worktree removal throws with
	// the databases intact; anything after that is reported rather than leaving the record half gone.
	async removeWorkspaceResources(w, project, warnings) {
		const hasCheckout = w.path !== project.path && fs.existsSync(w.path);
		const environment = w.environmentId
			? this.store.state.environments.find((e) => e.id === w.environmentId)
			: null;
		const { teardown } = w.provision?.config.scripts ?? {};
		if (teardown && hasCheckout)
			await runShell(teardown, {
				cwd: w.path,
				env: this.scriptEnv(w, project),
				log: this.provisionLog(w)
			}).catch((error) => warnings.push(`Teardown failed: ${error.message}`));
		if (environment?.scope === 'shared' && environment.status === 'running')
			await command('docker', ['compose', '-p', composeProject(w), 'down'], {
				timeout: GIT_WORKTREE_TIMEOUT,
				env: dockerEnv(environment.profile)
			}).catch((error) => warnings.push(`Compose down failed: ${error.message}`));
		// Without a VM, the Run tab's Compose commands used the host's Docker.
		if (!environment && w.composeOnHost)
			await command('docker', ['compose', '-p', composeProject(w), 'down'], {
				timeout: GIT_WORKTREE_TIMEOUT,
				env: agentEnv()
			}).catch((error) => warnings.push(`Compose down failed: ${error.message}`));
		if (hasCheckout)
			await command('git', ['-C', project.path, 'worktree', 'remove', w.path], {
				timeout: GIT_WORKTREE_TIMEOUT,
				env: agentEnv()
			});
		if (w.database)
			await (async () => {
				const pg = this.postgres(w, project);
				for (const name of await pg.owned(w.id)) await pg.drop(name);
			})().catch((error) => warnings.push(`Could not drop its databases: ${error.message}`));
		if (environment?.scope === 'isolated') {
			await this.destroyVm(environment).catch((error) =>
				warnings.push(`Could not delete VM ${environment.profile}: ${error.message}`)
			);
			this.store.state.environments = this.store.state.environments.filter(
				(e) => e !== environment
			);
		}
	}
	forgetWorkspaces(ids) {
		const state = this.store.state;
		this.queue = this.queue.filter(
			(j) => !state.chats.some((c) => c.id === j.chatId && ids.has(c.workspaceId))
		);
		for (const c of state.chats)
			if (ids.has(c.workspaceId)) {
				for (const m of c.members) this.killSession(`${c.id}:${m.id}`);
				fs.rmSync(this.uploads(c.id), { recursive: true, force: true });
			}
		state.chats = state.chats.filter((c) => !ids.has(c.workspaceId));
		state.tasks = state.tasks.filter((t) => !ids.has(t.workspaceId));
		for (const r of state.commandRuns)
			if (ids.has(r.workspaceId)) fs.rmSync(this.runLogFile(r.id), { force: true });
		state.commandRuns = state.commandRuns.filter((r) => !ids.has(r.workspaceId));
		state.workspaces = state.workspaces.filter((w) => !ids.has(w.id));
	}
	async deleteWorkspace(workspaceId) {
		const w = this.store.get('workspaces', workspaceId);
		const project = this.store.get('projects', w.projectId);
		if (w.path === project.path)
			throw new Error('The main workspace is your repository. Remove the project instead.');
		this.assertRemovable(w);
		await this.assertClean(w);
		const warnings = [];
		await this.removeWorkspaceResources(w, project, warnings);
		await command('git', ['-C', project.path, 'worktree', 'prune']).catch(() => {});
		this.forgetWorkspaces(new Set([w.id]));
		this.changed();
		return { warnings };
	}
	async deleteEnvironment(environmentId) {
		const e = this.store.get('environments', environmentId);
		if (e.busy) throw new Error('An environment operation is already running');
		if (this.store.state.workspaces.some((w) => w.environmentId === e.id))
			throw new Error('Detach this environment from its workspaces first');
		await this.destroyVm(e);
		this.store.state.environments = this.store.state.environments.filter((x) => x !== e);
		this.changed();
		return {};
	}
	environment(input) {
		const scope = input.scope === 'isolated' ? 'isolated' : 'shared';
		const env = {
			id: id(),
			name: requireText(input.name, 'Environment name'),
			scope,
			workspaceId: scope === 'isolated' ? input.workspaceId : null,
			profile: `wrx-${randomUUID().slice(0, 8)}`,
			status: 'not provisioned',
			busy: false,
			cpus: 2,
			memory: 4,
			disk: 30,
			log: '',
			createdAt: now()
		};
		this.store.state.environments.push(env);
		this.changed();
		return env;
	}
	attach(workspaceId, environmentId) {
		const w = this.store.get('workspaces', workspaceId);
		if (this.store.state.chats.some((c) => c.workspaceId === w.id && c.status === 'running'))
			throw new Error('Stop the active agent before changing its environment');
		if (environmentId) {
			const e = this.store.get('environments', environmentId);
			if (e.scope === 'isolated' && e.workspaceId !== w.id)
				throw new Error('This environment belongs to another workspace');
		}
		w.environmentId = environmentId || null;
		this.changed();
		return w;
	}
	async diff(workspaceId) {
		const w = this.store.get('workspaces', workspaceId);
		if (!(await repositoryRoot(w.path).catch(() => null))) return { status: '', diff: '', log: '' };
		const [status, diff, log] = await Promise.all([
			command('git', ['status', '--short'], { cwd: w.path }),
			command('git', ['diff', 'HEAD', '--', '.'], { cwd: w.path }).catch(() => ''),
			command('git', ['log', '-5', '--format=%h %s'], { cwd: w.path }).catch(() => '')
		]);
		return { status, diff, log };
	}
	// What the commit message writer reads: the diff, plus the top of each untracked file, which
	// `git diff HEAD` leaves out even though the commit will include it.
	async commitContext(workspaceId) {
		const w = this.store.get('workspaces', workspaceId);
		const changes = await this.diff(workspaceId);
		if (!changes.status) return { ...changes, untracked: [] };
		const list = await command(
			'git',
			['ls-files', '--others', '--exclude-standard', '-z', '--', '.'],
			{
				cwd: w.path
			}
		).catch(() => '');
		const untracked = [];
		for (const file of list.split('\0').filter(Boolean).slice(0, COMMIT_UNTRACKED_FILES)) {
			let head = '';
			let lines = 0;
			try {
				const full = path.join(w.path, file);
				const stat = fs.statSync(full);
				if (stat.isFile() && stat.size <= COMMIT_UNTRACKED_BYTES) {
					const text = fs.readFileSync(full, 'utf8');
					if (!text.includes('\0')) {
						const all = text.split('\n');
						lines = all.length;
						head = all.slice(0, COMMIT_UNTRACKED_LINES).join('\n');
					}
				}
			} catch {}
			untracked.push({ path: file, lines, head });
		}
		return { ...changes, untracked };
	}
	// Stages everything, commits, and pushes the branch, setting its upstream on first push.
	async commit(workspaceId, message) {
		const w = this.store.get('workspaces', workspaceId);
		const text = requireText(message, 'Commit message', 5000);
		if (!(await repositoryRoot(w.path).catch(() => null)))
			throw new Error('This workspace is not a Git repository');
		// Hooks (lint-staged and the like) need the agent PATH; a credential prompt would hang forever.
		const git = (args, timeout = 120000) =>
			command('git', args, {
				cwd: w.path,
				timeout,
				env: { ...agentEnv(), GIT_TERMINAL_PROMPT: '0' }
			}).catch((e) => {
				throw new Error(String(e.stderr || e.stdout || e.message).trim() || 'Git failed');
			});
		if (!(await git(['status', '--porcelain']))) throw new Error('Nothing to commit');
		await git(['add', '-A', '--', '.']);
		await git(['commit', '-m', text]);
		const remotes = (await git(['remote'])).split('\n').filter(Boolean);
		if (!remotes.length) return { pushed: false, reason: 'No remote to push to' };
		const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(
			() => ''
		);
		const remote = remotes.includes('origin') ? 'origin' : remotes[0];
		try {
			await git(upstream ? ['push'] : ['push', '-u', remote, 'HEAD'], 180000);
		} catch (e) {
			return { pushed: false, reason: e.message };
		}
		return { pushed: true };
	}
	// A chat is a Slack-style thread: the human and any number of agent members.
	// Each member keeps its own provider session. Messages addressed with @handle
	// queue that member's turn; members reply in turn and can hand off to each other.
	member(chat, input) {
		if (!['codex', 'claude'].includes(input.provider)) throw new Error('Choose Claude or Codex');
		const requested = requireText(
			input.name || (input.provider === 'codex' ? 'Codex' : 'Claude'),
			'Agent name',
			40
		);
		let name = requested,
			k = 2;
		while (chat.members.some((m) => m.name.toLowerCase() === name.toLowerCase()))
			name = `${requested} ${k++}`;
		const base = slug(input.handle || name);
		let handle = base,
			n = 2;
		while (RESERVED.has(handle) || chat.members.some((m) => m.handle === handle))
			handle = `${base}-${n++}`;
		const used = new Set(chat.members.map((m) => m.color));
		return {
			id: id(),
			name,
			handle,
			role: typeof input.role === 'string' ? input.role.trim().slice(0, 4000) : '',
			provider: input.provider,
			mode: MODES.includes(input.mode) ? input.mode : 'assess',
			fullAccess: input.fullAccess === true || input.fullAccess === 'on',
			model: typeof input.model === 'string' ? input.model.trim().slice(0, 100) : '',
			color: [0, 1, 2, 3, 4, 5, 6, 7].find((c) => !used.has(c)) ?? chat.members.length % 8,
			sessionId: null,
			status: 'idle',
			seen: 0,
			costUsd: 0,
			createdAt: now()
		};
	}
	chat(input) {
		this.store.get('workspaces', input.workspaceId);
		const chat = {
			id: id(),
			workspaceId: input.workspaceId,
			title: requireText(input.title || 'New thread', 'Title'),
			status: 'idle',
			members: [],
			leadId: null,
			maxHops: MAX_HOPS,
			messages: [],
			events: [],
			createdAt: now()
		};
		const team =
			Array.isArray(input.members) && input.members.length
				? input.members.slice(0, 12)
				: [
						{
							provider: input.provider,
							mode: input.mode,
							name: input.name,
							role: input.role,
							model: input.model
						}
					];
		for (const m of team) chat.members.push(this.member(chat, m));
		chat.leadId = chat.members[0].id;
		this.store.state.chats.push(chat);
		this.changed();
		return chat;
	}
	addMember(chatId, input) {
		const chat = this.store.get('chats', chatId);
		if (chat.members.length >= 12) throw new Error('A thread can have up to 12 agents');
		const m = this.member(chat, input);
		chat.members.push(m);
		if (input.lead) chat.leadId = m.id;
		chat.messages.push({
			id: id(),
			role: 'system',
			text: `${m.name} (@${m.handle}) joined the thread`,
			at: now()
		});
		this.changed();
		return m;
	}
	updateMember(chatId, memberId, patch) {
		const chat = this.store.get('chats', chatId);
		const m = chat.members.find((x) => x.id === memberId);
		if (!m) throw new Error('Agent not found in this thread');
		const model = typeof patch.model === 'string' ? patch.model.trim().slice(0, 100) : m.model;
		if (model !== m.model && m.status !== 'idle')
			throw new Error('Stop this agent before changing its model');
		if (patch.mode !== undefined) {
			if (!MODES.includes(patch.mode)) throw new Error('Invalid purpose');
			if (patch.mode !== m.mode) {
				if (m.status !== 'idle') throw new Error('Stop this agent before changing its permissions');
				// Resumed provider sessions retain their original sandbox permissions.
				m.sessionId = null;
				m.seen = 0;
			}
			m.mode = patch.mode;
		}
		if (typeof patch.fullAccess === 'boolean' && patch.fullAccess !== !!m.fullAccess) {
			if (m.status !== 'idle') throw new Error('Stop this agent before changing its permissions');
			m.fullAccess = patch.fullAccess;
			m.sessionId = null;
			m.seen = 0;
		}
		if (typeof patch.role === 'string') m.role = patch.role.trim().slice(0, 4000);
		if (model !== m.model) {
			m.model = model;
			m.sessionId = null;
			m.seen = 0;
			m.activeModel = null;
		}
		if (patch.lead) chat.leadId = m.id;
		// A live process keeps the flags it started with; the next turn starts one with the new ones.
		if (!m.sessionId) this.killSession(`${chat.id}:${m.id}`);
		this.changed();
		return m;
	}
	removeMember(chatId, memberId) {
		const chat = this.store.get('chats', chatId);
		const m = chat.members.find((x) => x.id === memberId);
		if (!m) throw new Error('Agent not found in this thread');
		if (m.status !== 'idle') throw new Error('Stop this agent before removing it');
		if (chat.members.length === 1) throw new Error('A thread needs at least one agent');
		this.killSession(`${chat.id}:${m.id}`);
		chat.members = chat.members.filter((x) => x !== m);
		if (chat.leadId === m.id) chat.leadId = chat.members[0].id;
		chat.messages.push({
			id: id(),
			role: 'system',
			text: `${m.name} (@${m.handle}) left the thread`,
			at: now()
		});
		this.changed();
		return chat;
	}
	route(chat, text, author) {
		const out = [];
		for (const name of mentions(text))
			for (const m of EVERYONE.has(name)
				? chat.members
				: chat.members.filter((x) => x.handle === name))
				if (m !== author && !out.includes(m)) out.push(m);
		return out;
	}
	enqueue(chat, member, hops, by) {
		if (this.queue.some((j) => j.chatId === chat.id && j.memberId === member.id)) return;
		this.queue.push({ chatId: chat.id, memberId: member.id, hops, by });
		if (member.status !== 'running') member.status = 'queued';
		if (chat.status !== 'running') chat.status = 'queued';
	}
	// Agents that can modify the checkout. Only one runs per workspace at a time so edits don't
	// collide; read-only agents (assess/review) run alongside everything.
	static writes(member) {
		return member.mode === 'implement' || !!member.fullAccess;
	}
	// One live run per (chat, member): { chatId, memberId, workspaceId, writer, child }.
	runs(chatId) {
		return [...this.running.values()].filter((r) => r.chatId === chatId);
	}
	chatRunning(chatId) {
		return this.runs(chatId).length > 0;
	}
	writing(workspaceId) {
		return [...this.running.values()].some((r) => r.workspaceId === workspaceId && r.writer);
	}
	pump() {
		for (const job of [...this.queue]) {
			const chat = this.store.state.chats.find((c) => c.id === job.chatId);
			const member = chat?.members.find((m) => m.id === job.memberId);
			if (!member) {
				this.queue.splice(this.queue.indexOf(job), 1);
				continue;
			}
			const w = this.store.get('workspaces', chat.workspaceId);
			if (
				this.running.has(`${chat.id}:${member.id}`) ||
				(Engine.writes(member) && this.writing(w.id)) ||
				w.provision?.status === 'running' ||
				w.database?.busy ||
				(w.environmentId && this.store.get('environments', w.environmentId).busy)
			)
				continue;
			if (chat.summarizing || this.prepareContext(chat, member, w)) continue;
			this.queue.splice(this.queue.indexOf(job), 1);
			this.run(chat, member, job);
		}
	}
	// Before a member's turn: rotate an oversized session, and make sure a fresh start in a long thread
	// has an up-to-date summary. Returns true while a summary is being written; pump() retries after.
	prepareContext(chat, member, w) {
		const rotate = !!member.sessionId && (member.turns || 0) >= ROTATE_TURNS;
		const fresh = !member.sessionId || rotate;
		const stale =
			chat.messages.length > SUMMARY_AFTER &&
			chat.messages.length - (chat.summaryUpTo || 0) > RECENT_WITH_SUMMARY &&
			chat.summaryTriedAt !== chat.messages.length;
		if (fresh && stale) {
			this.summarize(chat, member, w).finally(() => {
				if (rotate) this.dropSession(chat, member);
				this.changed();
				this.pump();
			});
			return true;
		}
		if (rotate) this.dropSession(chat, member);
		return false;
	}
	// Ends a member's provider session so its next turn starts from the summary and recent messages.
	dropSession(chat, member) {
		member.sessionId = null;
		member.turns = 0;
		member.seen = 0;
		this.killSession(`${chat.id}:${member.id}`);
	}
	// Folds the messages since the last summary into chat.summary with a one-shot provider run. Never
	// rejects: on failure the old summary stays and the turn goes ahead with it (or raw recent messages).
	summarize(chat, member, w) {
		const running = chat.messages.findIndex((m) => m.status === 'running');
		const upTo = running === -1 ? chat.messages.length : running;
		const name = (m) =>
			m.role === 'user'
				? '@you'
				: m.role === 'system'
					? 'Workbench'
					: `@${chat.members.find((x) => x.id === m.memberId)?.handle || 'former-agent'}`;
		const transcript = chat.messages
			.slice(chat.summaryUpTo || 0, upTo)
			.filter((m) => m.text)
			.map((m) => `[${name(m)}] ${m.text}`)
			.join('\n\n')
			.slice(-SUMMARY_INPUT_CHARS);
		chat.summarizing = true;
		chat.summaryTriedAt = chat.messages.length;
		this.changed();
		const environment = w.environmentId ? this.store.get('environments', w.environmentId) : null;
		return new Promise((resolve) => {
			let out = '';
			let child;
			const done = (text, error) => {
				if (!chat.summarizing) return;
				chat.summarizing = false;
				clearTimeout(timer);
				if (text?.trim()) {
					chat.summary = text.trim().slice(0, 12000);
					chat.summaryUpTo = upTo;
					chat.summaryError = null;
				} else chat.summaryError = error || 'Summary came back empty';
				resolve();
			};
			const timer = setTimeout(() => {
				if (child) killGroup(child, 'SIGKILL');
				done(null, 'Summary timed out');
			}, SUMMARY_TIMEOUT_MS);
			timer.unref?.();
			try {
				child = this.spawn(member.provider, summaryArgs(member.provider), {
					cwd: w.path,
					env: this.workspaceEnv(w, environment),
					detached: process.platform !== 'win32',
					stdio: ['pipe', 'pipe', 'pipe']
				});
			} catch (error) {
				done(null, error.message);
				return;
			}
			child.stdout.setEncoding('utf8');
			child.stderr.setEncoding('utf8');
			child.stdout.on('data', (chunk) => {
				out = (out + chunk).slice(-200000);
			});
			child.stderr.on('data', () => {});
			child.on('error', (error) => done(null, error.message));
			child.on('close', (code) => {
				if (code !== 0) return done(null, `Summary exited with code ${code}`);
				if (member.provider !== 'codex') return done(out);
				// Codex --json: the reply is the last completed agent_message item.
				let text = '';
				for (const line of out.split('\n')) {
					try {
						const data = JSON.parse(line);
						if (data.type === 'item.completed' && data.item?.type === 'agent_message')
							text = data.item.text;
					} catch {}
				}
				done(text);
			});
			child.stdin.on('error', () => {});
			child.stdin.end(summaryPrompt(chat.summary, transcript));
		});
	}
	uploads(chatId) {
		return path.join(this.store.directory, 'uploads', chatId);
	}
	// Copies images an agent generated during its turn into the thread so everyone can see them.
	postGenerated(chat, msg, member, since) {
		const found = codexGeneratedImages(member.sessionId, since);
		if (!found.length) return;
		const dir = this.uploads(chat.id);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		msg.images = found.map((f, i) => {
			const ext = GENERATED_EXT[path.extname(f.name).toLowerCase()];
			const file = `${msg.id}-${i}.${ext}`;
			fs.copyFileSync(f.path, path.join(dir, file));
			fs.chmodSync(path.join(dir, file), 0o600);
			return { file, name: f.name, type: GENERATED_TYPES[ext], size: f.stat.size, generated: true };
		});
	}
	// `attachments` may hold any file; PNG/JPEG/GIF/WebP become images agents see directly.
	turn(chatId, text, attachments = []) {
		const chat = this.store.get('chats', chatId);
		if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS)
			throw new Error(`Attach up to ${MAX_ATTACHMENTS} files`);
		text =
			attachments.length && !String(text ?? '').trim() ? '' : requireText(text, 'Message', 50000);
		let total = 0;
		const decoded = attachments.map((a, i) => {
			const data = Buffer.from(String(a?.data || ''), 'base64');
			const ext = IMAGE_TYPES[a?.type];
			const name = String(a?.name || (ext ? `image-${i + 1}.${ext}` : `file-${i + 1}`))
				.replace(/[\r\n]+/g, ' ')
				.slice(0, 120);
			if (ext && data.length > MAX_IMAGE_BYTES)
				throw new Error(`${name}: images must be under 5 MB`);
			if (data.length > MAX_FILE_BYTES) throw new Error(`${name}: files must be under 20 MB`);
			total += data.length;
			return { ext, data, name, type: ext ? a.type : String(a?.type || '').slice(0, 100) || null };
		});
		if (total > MAX_TOTAL_BYTES) throw new Error('Attachments must total under 32 MB');
		if (decoded.filter((a) => a.ext).length > MAX_IMAGES)
			throw new Error(`Attach up to ${MAX_IMAGES} images`);
		const msg = { id: id(), role: 'user', text, at: now() };
		if (decoded.length) {
			const dir = this.uploads(chat.id);
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			const images = [];
			const files = [];
			decoded.forEach((a, i) => {
				if (a.ext) {
					const file = `${msg.id}-${i}.${a.ext}`;
					fs.writeFileSync(path.join(dir, file), a.data, { mode: 0o600 });
					images.push({ file, name: a.name, type: a.type, size: a.data.length });
				} else {
					// Own folder per file so the agent sees the original name.
					const sub = `${msg.id}-${i}`;
					const file = `${sub}/${safeFileName(a.name, `file-${i + 1}`)}`;
					fs.mkdirSync(path.join(dir, sub), { mode: 0o700 });
					fs.writeFileSync(path.join(dir, file), a.data, { mode: 0o600 });
					files.push({ file, name: a.name, type: a.type, size: a.data.length });
				}
			});
			if (images.length) msg.images = images;
			if (files.length) msg.files = files;
		}
		chat.messages.push(msg);
		chat.error = null;
		const targets = this.route(chat, text, null);
		for (const m of targets.length
			? targets
			: [chat.members.find((m) => m.id === chat.leadId) || chat.members[0]])
			this.enqueue(chat, m, 0, 'you');
		this.changed();
		this.pump();
		return chat;
	}
	// Teammate messages this member hasn't received yet. Replies still being written are withheld and
	// tracked in member.held by run(), so they arrive complete on the member's next turn.
	unseen(chat, member) {
		const held = new Set(member.held);
		if (!member.sessionId)
			// A fresh session has no memory of the member's own earlier replies, so include them too.
			return chat.messages
				.slice(-(chat.summary ? RECENT_WITH_SUMMARY : RECENT_WITHOUT_SUMMARY))
				.filter((m) => m.status !== 'running');
		return chat.messages
			.filter((m, i) => i >= member.seen || held.has(m.id))
			.filter((m) => m.memberId !== member.id && m.status !== 'running');
	}
	// Where worktrees live, not which one is the agent's: its cwd says that, and it may move between them.
	worktreesContext(w) {
		const project = this.store.state.projects.find((p) => p.id === w.projectId);
		// A Git project's path is its repository root, so it has .git there. A plain folder has no worktrees.
		if (!project || !fs.existsSync(path.join(project.path, '.git'))) return '';
		return `Worktrees: this project's Workbench worktrees live under ${worktreesDirectory(project)}. Its primary checkout is ${project.path}. Your current directory is the checkout you were started in. \`git worktree list\` shows them all with their branches.\n`;
	}
	commandsContext(w) {
		const found = this.commandsFor(w);
		if (!found.length) return '';
		const listed = found.slice(0, PROMPT_COMMANDS).map(commandLine).join(', ');
		const more = found.length - PROMPT_COMMANDS;
		return `Project commands found in this checkout: ${listed}${more > 0 ? `, and ${more} more` : ''}.\n`;
	}
	prompt(chat, member, job, w, environment, images = [], files = []) {
		const first = !member.sessionId;
		const who = (m) =>
			m.role === 'user'
				? 'You (@you, the human)'
				: m.role === 'system'
					? 'Workbench'
					: ((x) => (x ? `${x.name} (@${x.handle})` : 'Former agent'))(
							chat.members.find((x) => x.id === m.memberId)
						);
		const roster = [
			'- @you — the human running this thread',
			...chat.members.map(
				(m) =>
					`- @${m.handle} — ${m.name}${m.id === member.id ? ' (this is you)' : ''}${m.id === chat.leadId ? ', thread lead' : ''} · ${m.provider}/${m.mode}${m.role ? ` · ${m.role.replace(/\s+/g, ' ').slice(0, 220)}` : ''}`
			)
		].join('\n');
		const history = this.unseen(chat, member).filter((m) => m.text || m.role !== 'agent');
		const transcript = history
			.map(
				(m) =>
					`[${who(m)}] ${m.text}${[...(m.images || []), ...(m.files || [])].length ? `${m.text ? ' ' : ''}[attached ${[...(m.images || []), ...(m.files || [])].map((i) => i.name).join(', ')}]` : ''}`
			)
			.join('\n\n')
			.slice(-24000);
		return [
			first
				? `You are ${member.name} (@${member.handle}), one of several AI agents collaborating with a human in a shared team thread named "${chat.title}" in Workbench, a Slack-like workspace chat.`
				: `You are ${member.name} (@${member.handle}) in the Workbench team thread "${chat.title}".`,
			member.role ? `Your role: ${member.role}` : '',
			MODE_PROMPTS[member.mode],
			member.provider === 'codex'
				? 'When a visual would help (mockups, ad creative, social posts, diagrams), create it with your built-in image generation tool. Every image you generate is posted to this thread automatically so teammates and the human can see it; refer to it in words rather than by file path.'
				: '',
			first
				? `${this.worktreesContext(w)}${this.commandsContext(w)}Runtime: ${environment ? `${environment.name} (${environment.profile}); Docker endpoint ${dockerEnv(environment.profile).DOCKER_HOST}. Agents execute on the host; the VM isolates dependencies only.` : 'No managed dependency VM attached.'}`
				: '',
			`Thread members:\n${roster}`,
			first
				? "How this thread works:\n- Write like a teammate in Slack: concise, direct, Markdown allowed.\n- @mention a teammate's handle when you need them to act or answer. Every agent you mention starts after your reply; several mentioned agents may work at the same time. Do not mention anyone just to acknowledge or thank them.\n- Use @all only when every agent truly needs to respond.\n- Address the human as @you, and ask @you when a decision needs a human.\n- Other agents may be working in parallel with you; you only see their replies once they finish. Read-only agents run concurrently; agents that edit files take turns in the workspace. Never claim work you have not done."
				: '',
			first && chat.summary
				? `Summary of the thread so far (older messages are not shown; ask @you if a detail you need is missing):\n${chat.summary}`
				: '',
			transcript
				? `${first ? (chat.summary ? 'Latest thread messages' : 'Recent thread messages') : 'New thread messages since your last turn'}:\n${transcript}`
				: '',
			images.length
				? `${images.length} image${images.length === 1 ? ' is' : 's are'} attached to this turn (${images.map((i) => i.name).join(', ')}). Look at them before replying.`
				: '',
			files.length
				? `The human attached ${files.length === 1 ? 'a file' : `${files.length} files`}. Read ${files.length === 1 ? 'it' : 'them'} from these absolute paths with your tools before replying (they are outside your working directory; do not edit them):\n${files.map((f) => `- ${f.name}${f.type ? ` (${f.type})` : ''}: ${f.path}`).join('\n')}`
				: '',
			`${job.by === 'you' ? 'The human addressed you.' : `@${job.by} mentioned you and is waiting for your reply.`} Reply now as ${member.name}.`
		]
			.filter(Boolean)
			.join('\n\n');
	}
	run(chat, member, job) {
		const w = this.store.get('workspaces', chat.workspaceId);
		const environment = w.environmentId ? this.store.get('environments', w.environmentId) : null;
		const images = this.unseen(chat, member)
			.flatMap((m) => m.images || [])
			.map((i) => ({ ...i, path: path.join(this.uploads(chat.id), i.file) }))
			.filter((i) => fs.existsSync(i.path))
			.slice(-MAX_IMAGES);
		const files = this.unseen(chat, member)
			.flatMap((m) => m.files || [])
			.map((f) => ({ ...f, path: path.join(this.uploads(chat.id), f.file) }))
			.filter((f) => fs.existsSync(f.path))
			.slice(-MAX_ATTACHMENTS * 2);
		const prompt = this.prompt(chat, member, job, w, environment, images, files);
		member.turns = (member.sessionId ? member.turns || 0 : 0) + 1;
		member.seen = chat.messages.length;
		member.held = chat.messages
			.filter((m) => m.status === 'running' && m.memberId !== member.id)
			.map((m) => m.id);
		const t = this.beginTurn(chat, member, job, w);
		if (member.provider === 'codex') this.runCodex(t, chat, member, w, environment, prompt, images);
		else this.sendClaude(t, chat, member, w, environment, prompt, images);
		return t.msg;
	}
	// Opens an agent message and marks the member running. Every turn — one the human or a teammate
	// asked for, or one a background task woke — goes through here and ends in the turn's finish().
	beginTurn(chat, member, job, w) {
		const msg = {
			id: id(),
			role: 'agent',
			memberId: member.id,
			text: '',
			blocks: [],
			status: 'running',
			at: now(),
			hops: job.hops,
			by: job.by
		};
		chat.messages.push(msg);
		member.status = 'running';
		chat.status = 'running';
		chat.error = null;
		const t = this.turnContext(chat, member, msg, job, w);
		this.running.set(t.key, t.run);
		this.changed();
		return t;
	}
	// Turns provider stream events into the message's blocks, and settles the turn when it ends.
	turnContext(chat, member, msg, job, w) {
		const key = `${chat.id}:${member.id}`;
		const started = Date.now();
		const tools = new Map();
		let resultError = false;
		let finished = false;
		const add = (block) => {
			msg.blocks.push(block);
			if (msg.blocks.length > 300) msg.blocks.splice(0, msg.blocks.length - 300);
			return block;
		};
		const say = (text) => {
			if (!text?.trim()) return;
			add({ kind: 'text', text });
			msg.text += (msg.text ? '\n\n' : '') + text;
		};
		const tool = (key, name, input) => {
			let b = tools.get(key);
			if (!b) {
				b = add({
					kind: 'tool',
					name,
					summary: toolSummary(name, input, w.path),
					detail: toolDetail(name, input),
					status: 'running'
				});
				tools.set(key, b);
			}
			return b;
		};
		const codexItem = (item, done) => {
			if (!item) return;
			if (item.type === 'agent_message') {
				if (done) say(item.text);
				return;
			}
			if (item.type === 'reasoning') {
				if (done && item.text) add({ kind: 'thinking', text: clip(item.text) });
				return;
			}
			if (item.type === 'todo_list') {
				msg.todos = (item.items || []).map((i) => ({
					content: i.text,
					status: i.completed ? 'completed' : 'pending'
				}));
				const next = msg.todos.find((t) => t.status === 'pending');
				if (next) next.status = 'in_progress';
				return;
			}
			const spec =
				item.type === 'command_execution'
					? ['Bash', { command: item.command }]
					: item.type === 'file_change'
						? ['Edit', { changes: item.changes }]
						: item.type === 'mcp_tool_call'
							? [`${item.server}.${item.tool}`, item.arguments]
							: item.type === 'web_search'
								? ['WebSearch', { query: item.query }]
								: null;
			if (!spec) return;
			const b = tool(item.id || `${item.type}-${tools.size}`, ...spec);
			if (done) {
				b.status =
					item.status === 'failed' || (item.exit_code != null && item.exit_code !== 0)
						? 'error'
						: 'done';
				const out = item.aggregated_output ?? item.result ?? item.error?.message;
				if (out != null)
					b.result = clip(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
			}
		};
		const handle = (data) => {
			if (data.type === 'thread.started') member.sessionId = data.thread_id;
			if (data.session_id) member.sessionId = data.session_id;
			if (data.type === 'system' && data.subtype === 'init' && data.model)
				member.activeModel = data.model;
			if (
				data.type === 'turn.failed' ||
				data.type === 'error' ||
				(data.type === 'result' && data.is_error)
			) {
				resultError = true;
				msg.error =
					data.error?.message || data.result || data.message || 'Provider reported a failure';
			}
			if (data.type === 'assistant' && !data.parent_tool_use_id)
				for (const c of data.message?.content || []) {
					if (c.type === 'text') say(c.text);
					else if (c.type === 'thinking' && c.thinking)
						add({ kind: 'thinking', text: clip(c.thinking) });
					else if (c.type === 'tool_use') {
						tool(c.id, c.name, c.input);
						if (c.name === 'TodoWrite' && Array.isArray(c.input?.todos))
							msg.todos = c.input.todos.map((t) => ({
								content: String(t.content ?? ''),
								status: t.status,
								activeForm: t.activeForm
							}));
					}
				}
			if (data.type === 'user' && !data.parent_tool_use_id)
				for (const c of data.message?.content || [])
					if (c.type === 'tool_result' && tools.has(c.tool_use_id)) {
						const b = tools.get(c.tool_use_id);
						b.status = c.is_error ? 'error' : 'done';
						b.result = clip(resultText(c.content));
					}
			if (data.type === 'result') {
				if (data.duration_ms) msg.durationMs = data.duration_ms;
				if (data.total_cost_usd) {
					msg.costUsd = data.total_cost_usd;
					member.costUsd = (member.costUsd || 0) + data.total_cost_usd;
				}
			}
			if (data.type?.startsWith('item.')) codexItem(data.item, data.type === 'item.completed');
			this.logEvent(chat, member, data);
		};
		const finish = (code, error, stderr = '') => {
			if (finished) return;
			finished = true;
			if (this.running.get(key) === run) this.running.delete(key);
			if (msg.status !== 'cancelled')
				msg.status = code === 0 && !error && !resultError ? 'done' : 'failed';
			for (const b of msg.blocks)
				if (b.kind === 'tool' && b.status === 'running')
					b.status = msg.status === 'done' ? 'done' : 'cancelled';
			if (msg.status === 'failed') {
				msg.error =
					msg.error ||
					(error?.code === 'ENOENT' && error.path === member.provider
						? missingCli(member.provider)
						: error?.message) ||
					stderr.trim() ||
					`Agent exited with code ${code}`;
				chat.error = msg.error;
			}
			if (member.provider === 'codex') this.postGenerated(chat, msg, member, started);
			msg.durationMs ??= Date.now() - started;
			if (msg.status === 'done') {
				const next = this.route(chat, msg.text, member);
				if (next.length && job.hops + 1 > (chat.maxHops ?? MAX_HOPS))
					chat.messages.push({
						id: id(),
						role: 'system',
						text: `Paused automatic handoffs after ${job.hops + 1} agent turns in a row. Reply to continue — mention who should go next.`,
						at: now()
					});
				else for (const m of next) this.enqueue(chat, m, job.hops + 1, member.handle);
			}
			member.status = this.queue.some((j) => j.chatId === chat.id && j.memberId === member.id)
				? 'queued'
				: 'idle';
			chat.status = this.chatRunning(chat.id)
				? 'running'
				: this.queue.some((j) => j.chatId === chat.id)
					? 'queued'
					: chat.status === 'cancelled'
						? 'cancelled'
						: { done: 'completed', cancelled: 'cancelled' }[msg.status] || 'failed';
			chat.updatedAt = now();
			this.changed();
			this.pump();
		};
		const run = {
			chatId: chat.id,
			memberId: member.id,
			workspaceId: w.id,
			writer: Engine.writes(member),
			child: null
		};
		return { key, msg, run, handle, finish };
	}
	// Parses one stdout line; anything that isn't JSON goes to the thread's activity log.
	parseLine(chat, line) {
		try {
			return JSON.parse(line);
		} catch {
			if (line.trim()) {
				chat.events.push(line.slice(0, 4000));
				this.changed();
			}
			return null;
		}
	}
	logEvent(chat, member, data) {
		const name =
			data.item?.command ||
			data.item?.type ||
			data.message?.content?.find((c) => c.type === 'tool_use')?.name;
		chat.events.push(`@${member.handle} · ${data.type}${name ? ` · ${name}` : ''}`);
		chat.events = chat.events.slice(-250);
		this.changed();
	}
	// Codex has no streaming input, so each turn is its own `codex exec` process.
	runCodex(t, chat, member, w, environment, prompt, images) {
		let pending = '';
		let stderr = '';
		let child;
		try {
			child = this.spawn(member.provider, agentArgs(member, images), {
				cwd: w.path,
				env: this.workspaceEnv(w, environment),
				detached: process.platform !== 'win32',
				stdio: ['pipe', 'pipe', 'pipe']
			});
		} catch (error) {
			t.finish(null, error);
			return;
		}
		const line = (l) => {
			const data = this.parseLine(chat, l);
			if (data) t.handle(data);
		};
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		t.run.child = child;
		child.stdout.on('data', (chunk) => {
			pending += chunk.toString();
			const lines = pending.split('\n');
			pending = lines.pop();
			for (const l of lines) line(l);
			if (pending.length > 2 * 1024 * 1024) pending = pending.slice(-65536);
		});
		child.stderr.on('data', (chunk) => {
			stderr = (stderr + chunk).slice(-16000);
			t.msg.diagnostics = stderr;
			this.changed();
		});
		const done = (code, error) => {
			if (pending) line(pending);
			pending = '';
			t.finish(code, error, stderr);
		};
		child.on('error', (error) => done(null, error));
		child.on('close', (code) => done(code));
		child.stdin.on('error', () => {});
		child.stdin.end(agentInput(member, prompt, images));
	}
	// Claude keeps one process per thread member. Each turn is a stream-json line on its stdin, and the
	// `result` event ends the turn while the process (and any background task it armed) stays up.
	sendClaude(t, chat, member, w, environment, prompt, images) {
		let s;
		try {
			s = this.ensureSession(chat, member, w, environment);
		} catch (error) {
			t.finish(null, error);
			return;
		}
		s.turn = t;
		s.stderr = '';
		t.run.child = s.child;
		s.child.stdin.write(agentInput(member, prompt, images));
	}
	ensureSession(chat, member, w, environment) {
		const key = `${chat.id}:${member.id}`;
		const live = this.sessions.get(key);
		if (live) return live;
		const uploads = this.uploads(chat.id);
		fs.mkdirSync(uploads, { recursive: true, mode: 0o700 });
		const child = this.spawn(member.provider, agentArgs(member, [], [uploads]), {
			cwd: w.path,
			env: this.workspaceEnv(w, environment),
			detached: process.platform !== 'win32',
			stdio: ['pipe', 'pipe', 'pipe']
		});
		const s = { key, chat, member, w, child, pending: '', stderr: '', turn: null, dead: false };
		this.sessions.set(key, s);
		member.live = true;
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk) => {
			s.pending += chunk.toString();
			const lines = s.pending.split('\n');
			s.pending = lines.pop();
			for (const line of lines) this.sessionLine(s, line);
			if (s.pending.length > 2 * 1024 * 1024) s.pending = s.pending.slice(-65536);
		});
		child.stderr.on('data', (chunk) => {
			s.stderr = (s.stderr + chunk).slice(-16000);
			if (s.turn) {
				s.turn.msg.diagnostics = s.stderr;
				this.changed();
			}
		});
		child.on('error', (error) => this.sessionClosed(s, null, error));
		child.on('close', (code) => this.sessionClosed(s, code));
		child.stdin.on('error', () => {});
		return s;
	}
	sessionLine(s, line) {
		const data = this.parseLine(s.chat, line);
		if (!data) return;
		if (!s.turn) {
			// Output between turns comes from a background task waking the agent. It gets its own
			// message, opened on the first thing the agent says; status pings alone only get logged.
			if (s.dead || data.type !== 'assistant' || data.parent_tool_use_id) {
				if (data.session_id) s.member.sessionId = data.session_id;
				if (data.type === 'result' && data.total_cost_usd)
					s.member.costUsd = (s.member.costUsd || 0) + data.total_cost_usd;
				this.logEvent(s.chat, s.member, data);
				return;
			}
			s.turn = this.beginTurn(s.chat, s.member, { hops: 0, by: 'background' }, s.w);
			s.turn.run.child = s.child;
			s.stderr = '';
		}
		const t = s.turn;
		t.handle(data);
		if (data.type === 'result') {
			s.turn = null;
			t.finish(0, null, s.stderr);
		}
	}
	sessionClosed(s, code, error) {
		if (s.closed) return;
		s.closed = true;
		if (this.sessions.get(s.key) === s) {
			this.sessions.delete(s.key);
			s.member.live = false;
		}
		if (s.pending) this.sessionLine(s, s.pending);
		s.pending = '';
		const t = s.turn;
		s.turn = null;
		if (t) t.finish(code, error, s.stderr);
		else this.changed();
	}
	// Ends a member's Claude process. It leaves the registry at once, so the next turn starts a fresh
	// one; a turn still in flight settles when the process closes.
	killSession(key) {
		const s = this.sessions.get(key);
		if (!s) return;
		this.sessions.delete(key);
		s.dead = true;
		s.member.live = false;
		killGroup(s.child, 'SIGTERM');
		setTimeout(() => {
			if (!s.closed) killGroup(s.child, 'SIGKILL');
		}, 3000).unref();
	}
	cancel(chatId) {
		const c = this.store.get('chats', chatId);
		const runs = this.runs(chatId);
		this.queue = this.queue.filter((j) => j.chatId !== chatId);
		for (const m of c.members) if (m.status === 'queued') m.status = 'idle';
		for (const msg of c.messages)
			if (msg.role === 'agent' && msg.status === 'running') msg.status = 'cancelled';
		if (runs.length || c.status === 'queued') c.status = 'cancelled';
		// Stop also ends idle Claude sessions, and with them any watcher they armed.
		for (const m of c.members) this.killSession(`${chatId}:${m.id}`);
		for (const run of runs) {
			const child = run.child;
			if (!child) continue;
			killGroup(child, 'SIGTERM');
			const key = `${run.chatId}:${run.memberId}`;
			const timer = setTimeout(() => {
				if (this.running.get(key)?.child === child) killGroup(child, 'SIGKILL');
			}, 3000);
			timer.unref();
		}
		this.changed();
	}
	// What an agent or a Run tab command gets: its workspace's Docker target, ports and env values.
	workspaceEnv(w, environment) {
		return {
			...agentEnv(environment ? dockerEnv(environment.profile) : process.env),
			...w.provision?.env
		};
	}
	commandsFor(w) {
		const saved = this.store.state.projects.find((p) => p.id === w.projectId)?.runCommands || [];
		return [
			...discoverCommands(w.path, { composeProject: composeProject(w) }),
			...saved.map(customTask)
		];
	}
	runLogFile(runId) {
		return path.join(this.store.directory, 'run-logs', `${runId}.log`);
	}
	runTasks(workspaceId) {
		const w = this.store.get('workspaces', workspaceId);
		const saved = this.store.get('projects', w.projectId).runVariants || [];
		return this.commandsFor(w).map((t) => ({
			...t,
			line: commandLine(t),
			variants: saved
				.filter((v) => v.taskId === t.id)
				.map((v) => ({
					...v,
					key: variantKey(t.id, v.id),
					line: commandLine(withFlags(t, parseFlags(v.flags)))
				}))
		}));
	}
	// Variants belong to the project, so every worktree has them. A variant stays saved when a branch
	// lacks its command, and comes back on a branch that has it.
	runVariantSave(input) {
		const w = this.store.get('workspaces', input.workspaceId);
		const project = this.store.get('projects', w.projectId);
		const task = this.commandsFor(w).find((t) => t.id === input.taskId);
		if (!task) throw new Error('This command is no longer in the workspace. Refresh the list.');
		const name = requireText(input.name, 'Variant name', 60);
		const flags = String(input.flags ?? '').trim();
		if (flags.length > 1000) throw new Error('Flags are too long (maximum 1000 characters)');
		parseFlags(flags);
		const env = parseEnvLines(String(input.env ?? ''));
		project.runVariants ??= [];
		if (
			project.runVariants.some(
				(v) => v.taskId === task.id && v.name === name && v.id !== input.variantId
			)
		)
			throw new Error(`"${task.name}" already has a variant named "${name}"`);
		const fields = { name, flags, env };
		let variant;
		if (input.variantId) {
			variant = project.runVariants.find((v) => v.id === input.variantId && v.taskId === task.id);
			if (!variant) throw new Error('This variant no longer exists');
			Object.assign(variant, fields);
		} else {
			variant = { id: id(), taskId: task.id, ...fields };
			project.runVariants.push(variant);
		}
		this.changed();
		return variant;
	}
	runVariantDelete(workspaceId, variantId) {
		const w = this.store.get('workspaces', workspaceId);
		const project = this.store.get('projects', w.projectId);
		project.runVariants = (project.runVariants || []).filter((v) => v.id !== variantId);
		this.changed();
		return {};
	}
	// Custom commands belong to the project, like variants, so every worktree has them.
	runCommandSave(input) {
		const w = this.store.get('workspaces', input.workspaceId);
		const project = this.store.get('projects', w.projectId);
		const name = requireText(input.name, 'Command name', 60);
		const line = String(input.line ?? '').trim();
		if (line.length > 1000) throw new Error('Command is too long (maximum 1000 characters)');
		parseCommand(line);
		const cwd = parseFolder(input.cwd);
		project.runCommands ??= [];
		if (project.runCommands.some((c) => c.name === name && c.id !== input.commandId))
			throw new Error(`There is already a custom command named "${name}"`);
		const fields = { name, line, cwd };
		let saved;
		if (input.commandId) {
			saved = project.runCommands.find((c) => c.id === input.commandId);
			if (!saved) throw new Error('This command no longer exists');
			Object.assign(saved, fields);
		} else {
			saved = { id: id(), ...fields };
			project.runCommands.push(saved);
		}
		this.changed();
		return saved;
	}
	runCommandDelete(workspaceId, commandId) {
		const w = this.store.get('workspaces', workspaceId);
		const project = this.store.get('projects', w.projectId);
		project.runCommands = (project.runCommands || []).filter((c) => c.id !== commandId);
		project.runVariants = (project.runVariants || []).filter(
			(v) => v.taskId !== `custom:${commandId}`
		);
		this.changed();
		return {};
	}
	// Takes a task id, never a command: only what this checkout declares right now, or a command saved
	// on the project, can be started.
	runStart(workspaceId, taskId, variantId) {
		const w = this.store.get('workspaces', workspaceId);
		if (w.provision?.status === 'running') throw new Error('Workspace setup is still running');
		if (w.database?.busy) throw new Error('A database operation is running');
		const environment = w.environmentId ? this.store.get('environments', w.environmentId) : null;
		if (environment?.busy) throw new Error('An environment operation is running');
		const task = this.commandsFor(w).find((t) => t.id === taskId);
		if (!task) throw new Error('This command is no longer in the workspace. Refresh the list.');
		const cwd = task.cwd ? path.join(w.path, task.cwd) : w.path;
		if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory())
			throw new Error(`This checkout has no folder named ${task.cwd || w.path}`);
		let variant = null;
		if (variantId) {
			variant = this.store
				.get('projects', w.projectId)
				.runVariants?.find((v) => v.id === variantId && v.taskId === task.id);
			if (!variant) throw new Error('This variant no longer exists. Refresh the list.');
		}
		const key = variant ? variantKey(task.id, variant.id) : task.id;
		const name = variant ? `${task.name} · ${variant.name}` : task.name;
		const invocation = variant ? withFlags(task, parseFlags(variant.flags)) : task;
		const envNames = Object.keys(variant?.env || {});
		const { commandRuns } = this.store.state;
		if (
			commandRuns.some((r) => r.workspaceId === w.id && r.taskId === key && r.status === 'running')
		)
			throw new Error(`"${name}" is already running`);
		const run = {
			id: id(),
			workspaceId: w.id,
			taskId: key,
			name,
			source: task.source,
			line: commandLine(invocation),
			// Names only: a value could be a secret, and this is kept in history and sent to the browser.
			envNames,
			status: 'running',
			exitCode: null,
			error: null,
			startedAt: now(),
			finishedAt: null
		};
		const file = this.runLogFile(run.id);
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		const header = `$ ${run.line}\n${envNames.length ? `Env values set: ${envNames.join(', ')}\n` : ''}`;
		fs.writeFileSync(file, header, { mode: 0o600 });
		commandRuns.push(run);
		// Removing the workspace takes down this project name, which a custom command doesn't use.
		if (task.command === 'docker' && !task.custom && !environment) w.composeOnHost = true;
		const finish = (status, exitCode, error) => {
			if (run.status !== 'running') return;
			run.status = status;
			run.exitCode = exitCode;
			run.error = error;
			run.finishedAt = now();
			this.commandChildren.delete(run.id);
			this.pruneCommandRuns(w.id);
			this.changed();
		};
		let child;
		try {
			child = this.spawn(invocation.command, invocation.args, {
				cwd,
				env: { ...withVirtualenv(this.workspaceEnv(w, environment), cwd, w.path), ...variant?.env },
				detached: process.platform !== 'win32',
				stdio: ['ignore', 'pipe', 'pipe']
			});
		} catch (error) {
			finish('failed', null, error.message);
			return run;
		}
		const entry = { child, stopping: false };
		this.commandChildren.set(run.id, entry);
		let size = 0;
		const append = (data) => {
			size += data.length;
			try {
				// A dev server can run for days, so the file is started over rather than left to grow.
				if (size > RUN_LOG_LIMIT) {
					fs.writeFileSync(file, 'Earlier output was removed to save disk space.\n', {
						mode: 0o600
					});
					size = data.length;
				}
				fs.appendFileSync(file, data);
			} catch {}
		};
		child.stdout.on('data', append);
		child.stderr.on('data', append);
		child.on('error', (error) =>
			finish(
				'failed',
				null,
				error.code === 'ENOENT' ? `${task.command} isn't installed or isn't on PATH` : error.message
			)
		);
		// `close` waits for output to end, so a run isn't finished while something in it can still write.
		child.on('close', (code, signal) => {
			if (entry.stopping) finish('stopped', code, null);
			else if (code === 0) finish('exited', 0, null);
			else finish('failed', code, signal ? `Ended by ${signal}` : `Exited with code ${code}`);
		});
		this.changed();
		return run;
	}
	runStop(runId) {
		const run = this.store.get('commandRuns', runId);
		const entry = this.commandChildren.get(run.id);
		if (!entry) throw new Error('This command is not running');
		entry.stopping = true;
		killGroup(entry.child, 'SIGTERM');
		setTimeout(() => {
			if (this.commandChildren.get(run.id) === entry) killGroup(entry.child, 'SIGKILL');
		}, 3000).unref();
		return run;
	}
	// Called from the server's exit. Commands run in their own process groups, so they'd outlive it.
	stopCommands() {
		for (const { child } of this.commandChildren.values()) killGroup(child, 'SIGTERM');
	}
	// Called from the server's exit. Idle Claude sessions aren't in `running`, so cancel() misses them.
	stopSessions() {
		for (const key of [...this.sessions.keys()]) this.killSession(key);
	}
	runLog(runId) {
		const run = this.store.get('commandRuns', runId);
		return { status: run.status, log: readLogTail(this.runLogFile(run.id), RUN_LOG_TAIL) };
	}
	removeCommandRuns(runs) {
		const removed = new Set(runs);
		for (const r of removed) fs.rmSync(this.runLogFile(r.id), { force: true });
		this.store.state.commandRuns = this.store.state.commandRuns.filter((r) => !removed.has(r));
		this.changed();
	}
	runDelete(runId) {
		const run = this.store.get('commandRuns', runId);
		if (run.status === 'running') throw new Error('Stop this command before deleting it');
		this.removeCommandRuns([run]);
		return {};
	}
	runClear(workspaceId) {
		this.removeCommandRuns(
			this.store.state.commandRuns.filter(
				(r) => r.workspaceId === workspaceId && r.status !== 'running'
			)
		);
		return {};
	}
	pruneCommandRuns(workspaceId) {
		const state = this.store.state;
		const finished = state.commandRuns.filter(
			(r) => r.workspaceId === workspaceId && r.status !== 'running'
		);
		this.removeCommandRuns(finished.slice(0, -RUNS_KEPT_PER_WORKSPACE));
	}
	deleteChat(chatId) {
		const chat = this.store.get('chats', chatId);
		if (this.chatRunning(chat.id))
			throw new Error('Stop the running agents before deleting this conversation');
		this.queue = this.queue.filter((j) => j.chatId !== chat.id);
		for (const m of chat.members) this.killSession(`${chat.id}:${m.id}`);
		this.store.state.chats = this.store.state.chats.filter((c) => c !== chat);
		fs.rmSync(this.uploads(chat.id), { recursive: true, force: true });
		this.changed();
		return {};
	}
	// Unregisters a project. The original checkout is never touched; Workbench-created worktrees are
	// removed only when clean (their branches stay in the repository).
	async deleteProject(projectId) {
		const project = this.store.get('projects', projectId);
		const workspaces = this.store.state.workspaces.filter((w) => w.projectId === project.id);
		const repository = fs.existsSync(project.path);
		for (const w of workspaces) this.assertRemovable(w);
		if (repository)
			for (const w of workspaces) if (w.path !== project.path) await this.assertClean(w);
		const warnings = [];
		for (const w of workspaces) {
			if (repository) await this.removeWorkspaceResources(w, project, warnings);
		}
		if (repository) await command('git', ['-C', project.path, 'worktree', 'prune']).catch(() => {});
		if (project.database)
			await new Postgres(project.database, project.path, { env: agentEnv() })
				.drop(baseDatabase(project.id))
				.catch((error) => warnings.push(`Could not drop its base database: ${error.message}`));
		this.forgetWorkspaces(new Set(workspaces.map((w) => w.id)));
		this.store.state.projects = this.store.state.projects.filter((p) => p !== project);
		this.changed();
		return { warnings };
	}
	runtime(environmentId, action, workspaceId) {
		const e = this.store.get('environments', environmentId);
		if (e.busy) throw new Error('An environment operation is already running');
		const attached = this.store.state.workspaces
			.filter((w) => w.environmentId === e.id)
			.map((w) => w.id);
		if (
			this.store.state.chats.some((c) => attached.includes(c.workspaceId) && c.status === 'running')
		)
			throw new Error('Stop agents using this environment first');
		let bin = 'colima';
		let args;
		let options = { env: agentEnv() };
		if (action === 'start')
			args = [
				'--profile',
				e.profile,
				'start',
				'--runtime',
				'docker',
				'--cpu',
				String(e.cpus),
				'--memory',
				String(e.memory),
				'--disk',
				String(e.disk),
				'--activate=false'
			];
		else if (action === 'stop') args = ['--profile', e.profile, 'stop'];
		else if (['up', 'down', 'ps'].includes(action)) {
			const w = this.store.get('workspaces', workspaceId);
			if (w.environmentId !== e.id)
				throw new Error('Environment is not attached to this workspace');
			const file = [
				'compose.yaml',
				'compose.yml',
				'docker-compose.yml',
				'docker-compose.yaml'
			].find((f) => fs.existsSync(path.join(w.path, f)));
			if (!file) throw new Error('No Compose file found in the workspace root');
			bin = 'docker';
			args = [
				'compose',
				'-p',
				`wrx-${w.id.slice(0, 8)}`,
				'-f',
				file,
				...(action === 'up' ? ['up', '-d'] : action === 'down' ? ['down'] : ['ps', '--all'])
			];
			options = { cwd: w.path, env: dockerEnv(e.profile) };
		} else throw new Error('Unknown runtime action');
		e.busy = true;
		e.log = `$ ${bin} ${args.join(' ')}\n`;
		this.changed();
		const child = this.spawn(bin, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
		const append = (data) => {
			e.log = (e.log + data).slice(-80000);
			this.changed();
		};
		child.stdout.on('data', append);
		child.stderr.on('data', append);
		let finished = false;
		const finish = (code, error) => {
			if (finished) return;
			finished = true;
			e.busy = false;
			if (action === 'start') e.status = code === 0 ? 'running' : 'error';
			if (action === 'stop' && code === 0) e.status = 'stopped';
			append(`\n${error?.message || `Exited with code ${code}`}\n`);
			this.pump();
		};
		child.on('error', (error) => finish(null, error));
		child.on('close', (code) => finish(code));
		return e;
	}
}
