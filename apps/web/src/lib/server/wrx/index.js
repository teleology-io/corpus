/* eslint-disable @typescript-eslint/ban-ts-comment, no-empty -- verbatim WRX port */
// @ts-nocheck — ported from WRX server/index.mjs (plain JS).
// Workbench host: one WRX store + engine per Corpus user, served under /api/wrx/*.
// Corpus auth replaces WRX's LAN pairing and per-start CSRF token.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { chooseDirectory, listDirectories } from './directories.js';
import { listDirectory, readFilePreview, searchFiles, serveRaw } from './files.js';
import {
	Store,
	Engine,
	command,
	agentEnv,
	id,
	now,
	requireText,
	clientChats,
	repositoryRoot
} from './core.js';
import { optionalEnv } from '@corpus/db';
import { searchRank } from '../search-matching.js';
import { Terminals } from './terminal.js';

const root = path.resolve(process.env.WRX_DATA || '.wrx');
const machine = { id: os.hostname(), name: os.hostname() };
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

// Survives Vite HMR re-imports in dev so running agents and SSE clients aren't orphaned.
const hosts = (globalThis.__wrxHosts ??= new Map());

function lockDirectory(directory) {
	const lock = path.join(directory, 'server.lock');
	if (fs.existsSync(lock)) {
		const previous = Number(fs.readFileSync(lock, 'utf8'));
		let alive = previous !== process.pid && Number.isInteger(previous) && previous > 0;
		if (alive) {
			try {
				process.kill(previous, 0);
			} catch (error) {
				if (error.code === 'ESRCH') alive = false;
			}
		}
		if (alive) throw new Error(`Another Workbench host is using ${directory} (PID ${previous})`);
	}
	fs.writeFileSync(lock, String(process.pid), { mode: 0o600 });
	process.once('exit', () => {
		try {
			if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock);
		} catch {}
	});
}

const userDirectory = (userId) => path.join(root, String(userId).replace(/[^\w-]/g, '_'));

function host(userId) {
	let h = hosts.get(userId);
	if (h) {
		h.terminals ??= new Terminals(); // a host from before an HMR reload that added terminals
		return h;
	}
	const directory = userDirectory(userId);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	lockDirectory(directory);
	const store = new Store(directory);
	const clients = new Set();
	const engine = new Engine(store, () => {
		for (const send of clients) send('event: change\ndata: {}\n\n');
	});
	// Agents run on this machine, so a separate address can be set when PUBLIC_APP_URL isn't reachable here.
	engine.mcpUrl = new URL(
		'/api/mcp',
		optionalEnv('CORPUS_MCP_URL') ?? optionalEnv('PUBLIC_APP_URL') ?? 'http://localhost:2222'
	).href;
	h = { directory, store, engine, clients, terminals: new Terminals() };
	hosts.set(userId, h);
	void probeRuntimes();
	// Agents run detached in their own process groups; stop them with the server.
	process.once('exit', () => {
		for (const chatId of new Set([...engine.running.values()].map((r) => r.chatId)))
			try {
				engine.cancel(chatId);
			} catch {}
		engine.stopCommands();
		engine.stopSessions();
		h.terminals.closeAll();
	});
	return h;
}

/**
 * Every workbench task for a user, labelled with its project and workspace, for the Corpus
 * dashboard. Users who never opened the workbench get [] without creating any state.
 * @returns {import('#lib/types.js').WorkbenchTaskDTO[]}
 */
export function workbenchTasks(userId) {
	if (!hosts.has(userId) && !fs.existsSync(path.join(userDirectory(userId), 'state.json')))
		return [];
	const { projects, workspaces, tasks } = host(userId).store.state;
	return tasks.map((t) => {
		const w = workspaces.find((x) => x.id === t.workspaceId);
		return {
			id: t.id,
			title: t.title,
			status: t.status,
			createdAt: t.createdAt,
			completedAt: t.completedAt ?? null,
			workspaceId: t.workspaceId,
			workspace: w?.name ?? null,
			project: projects.find((p) => p.id === w?.projectId)?.name ?? null
		};
	});
}

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
const githubRepo = (remoteUrl) =>
	/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remoteUrl.trim())?.[1] ?? null;

/**
 * Read-only Workbench activity in [from, to) for the standup: agent threads with turns in the
 * window (and exact GitHub PR URLs they mention), the user's own commits per repository, and
 * tasks. Never starts agents or changes state. Users who never opened the workbench get nothing.
 * @param {string} userId
 * @param {Date} from
 * @param {Date} to
 */
export async function workbenchActivity(userId, from, to) {
	const empty = { threads: [], commits: [], tasks: [] };
	if (!hosts.has(userId) && !fs.existsSync(path.join(userDirectory(userId), 'state.json')))
		return empty;
	const { projects, workspaces, chats } = host(userId).store.state;
	const inWindow = (at) => !!at && at >= from.toISOString() && at < to.toISOString();
	const label = (wid) => {
		const w = workspaces.find((x) => x.id === wid);
		return {
			workspace: w?.name ?? null,
			project: projects.find((p) => p.id === w?.projectId)?.name ?? null
		};
	};
	const link = (params) => `/workbench?${new URLSearchParams(params)}`;

	const threads = [];
	for (const c of chats) {
		const turns = c.messages.filter((m) => m.role === 'agent' && inWindow(m.at));
		if (!turns.length) continue;
		const last = c.messages.filter((m) => m.role === 'agent').at(-1);
		const prUrls = new Set();
		for (const m of c.messages)
			if (inWindow(m.at) && m.text) for (const u of m.text.match(PR_URL) ?? []) prUrls.add(u);
		threads.push({
			id: c.id,
			title: c.title || 'Untitled thread',
			workspaceId: c.workspaceId,
			...label(c.workspaceId),
			url: link({ workspace: c.workspaceId, tab: 'agents', chat: c.id }),
			turns: turns.length,
			failed: turns.filter((m) => m.status === 'failed').length,
			lastStatus: last?.status ?? null,
			lastAt: turns.at(-1).at,
			prUrls: [...prUrls]
		});
	}

	// Worktrees of one repository share history, so each commit is counted once per repository.
	const commits = [];
	const seen = new Set();
	for (const w of workspaces) {
		if (projects.find((p) => p.id === w.projectId)?.folder || !fs.existsSync(w.path)) continue;
		try {
			const email = await command('git', ['-C', w.path, 'config', 'user.email'], { timeout: 5000 });
			if (!email) continue;
			const out = await command(
				'git',
				[
					'-C',
					w.path,
					'log',
					'HEAD',
					'--no-merges',
					`--author=${email}`,
					`--since=${from.toISOString()}`,
					`--until=${to.toISOString()}`,
					'--format=%H%x1f%cI%x1f%s',
					'-n',
					'50'
				],
				{ timeout: 5000 }
			);
			const remote = await command('git', ['-C', w.path, 'remote', 'get-url', 'origin'], {
				timeout: 5000
			}).catch(() => '');
			const repo = githubRepo(remote);
			for (const line of out.split('\n').filter(Boolean)) {
				const [sha, at, subject] = line.split('\x1f');
				if (!sha || seen.has(sha) || !inWindow(new Date(at).toISOString())) continue;
				seen.add(sha);
				commits.push({
					sha,
					at: new Date(at).toISOString(),
					subject: subject ?? '',
					workspaceId: w.id,
					branch: w.branch,
					...label(w.id),
					url: repo ? `https://github.com/${repo}/commit/${sha}` : null,
					workspaceUrl: link({ workspace: w.id })
				});
			}
		} catch {
			// Not a repository any more, git missing, or a timeout: no commits from this workspace.
		}
	}
	return { threads, commits, tasks: workbenchTasks(userId) };
}

/**
 * WRX's global search (projects, workspaces, conversations, messages, tasks, environments), moved
 * server-side so the Corpus-wide palette can include it. Results deep-link into /workbench.
 * @returns {import('#lib/types.js').SearchResult[]}
 */
export function workbenchSearch(userId, query) {
	if (!hosts.has(userId) && !fs.existsSync(path.join(userDirectory(userId), 'state.json')))
		return [];
	const state = host(userId).store.state;
	const terms = String(query).toLowerCase().trim().split(/\s+/).filter(Boolean);
	if (!terms.length) return [];
	const link = (params) => `/workbench?${new URLSearchParams(params)}`;
	const context = (wid) => {
		const w = state.workspaces.find((w) => w.id === wid);
		return [state.projects.find((p) => p.id === w?.projectId)?.name, w?.name]
			.filter(Boolean)
			.join(' / ');
	};
	const entries = [];
	const add = (kind, title, detail, href, extra = '') =>
		entries.push({
			kind,
			title,
			detail,
			href,
			text: `${kind} ${title} ${detail} ${extra}`.toLowerCase()
		});
	for (const p of state.projects) {
		const w = state.workspaces.find((w) => w.projectId === p.id);
		add('Project', p.name, p.path, w ? link({ workspace: w.id }) : '/workbench');
	}
	for (const w of state.workspaces)
		add('Workspace', w.name, `${context(w.id)} · ${w.branch}`, link({ workspace: w.id }), w.path);
	for (const c of state.chats) {
		const href = link({ workspace: c.workspaceId, tab: 'agents', chat: c.id });
		add(
			'Conversation',
			c.title,
			context(c.workspaceId),
			href,
			c.members.map((m) => `${m.name} @${m.handle}`).join(' ')
		);
		for (const m of c.messages)
			if (m.text)
				add(
					'Message',
					m.text.replace(/\s+/g, ' ').slice(0, 180),
					`${context(c.workspaceId)} · ${c.title}`,
					link({ workspace: c.workspaceId, tab: 'agents', chat: c.id, message: m.id }),
					m.text
				);
	}
	for (const t of state.tasks)
		add(
			'Workbench task',
			t.title,
			`${context(t.workspaceId)} · ${t.status}`,
			link({ workspace: t.workspaceId, tab: 'tasks' })
		);
	for (const e of state.environments) {
		const w = state.workspaces.find((w) => w.environmentId === e.id);
		add(
			'Environment',
			e.name,
			`${e.scope} · ${e.status}`,
			w ? link({ workspace: w.id, tab: 'runtime' }) : link({ dialog: 'environments' })
		);
	}
	const kinds = new Map();
	return entries
		.filter((e) => terms.every((t) => e.text.includes(t)))
		.sort((a, b) => searchRank(query, a.title) - searchRank(query, b.title))
		.filter((e) => {
			const n = (kinds.get(e.kind) ?? 0) + 1;
			kinds.set(e.kind, n);
			return n <= 8;
		})
		.map(({ text: _text, ...e }) => e);
}

const json = (code, value) =>
	new Response(JSON.stringify(value), {
		status: code,
		headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
	});

let toolsCache;
async function tools() {
	if (toolsCache && Date.now() - toolsCache.at < 30000) return toolsCache.value;
	const names = ['git', 'codex', 'claude', 'docker', 'colima'];
	const entries = await Promise.all(
		names.map(async (name) => {
			try {
				return [
					name,
					{
						available: true,
						version: (
							await command(name, [name === 'colima' ? 'version' : '--version'], {
								timeout: 5000,
								env: agentEnv()
							})
						).split('\n')[0]
					}
				];
			} catch {
				return [name, { available: false }];
			}
		})
	);
	toolsCache = { at: Date.now(), value: Object.fromEntries(entries) };
	return toolsCache.value;
}

function addresses() {
	return Object.values(os.networkInterfaces())
		.flat()
		.filter((a) => a && !a.internal && a.family === 'IPv4')
		.map((a) => a.address);
}

async function readBody(request, limit = 100000) {
	const raw = await request.text();
	if (raw.length > limit) throw new Error('Request too large');
	return JSON.parse(raw || '{}');
}

// One workspace's terminal output, as `reset`, `data` (a JSON string) and `exit` events.
function terminalEvents(h, workspaceId, request) {
	const encoder = new TextEncoder();
	let cleanup = () => {};
	const stream = new ReadableStream({
		start(controller) {
			let closed = false;
			const end = () => {
				if (closed) return;
				closed = true;
				cleanup();
				try {
					controller.close();
				} catch {}
			};
			const send = (chunk) => {
				try {
					controller.enqueue(encoder.encode(chunk));
				} catch {
					end();
				}
			};
			send('retry: 2000\n\n');
			const heartbeat = setInterval(() => send(': ping\n\n'), 20000);
			let unsubscribe = () => {};
			cleanup = () => {
				clearInterval(heartbeat);
				unsubscribe();
				cleanup = () => {};
			};
			unsubscribe = h.terminals.subscribe(workspaceId, (type, data) => {
				if (type === 'data') send(`event: data\ndata: ${JSON.stringify(data)}\n\n`);
				else if (type === 'reset') send('event: reset\ndata: {}\n\n');
				else {
					send(`event: exit\ndata: ${JSON.stringify({ exitCode: data })}\n\n`);
					// Defer so a subscribe that ends at once has finished assigning `unsubscribe`.
					queueMicrotask(end);
				}
			});
			request.signal.addEventListener('abort', end);
		},
		cancel() {
			cleanup();
		}
	});
	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
}

function events(h, request) {
	const encoder = new TextEncoder();
	let cleanup = () => {};
	const stream = new ReadableStream({
		start(controller) {
			const send = (chunk) => {
				try {
					controller.enqueue(encoder.encode(chunk));
				} catch {
					cleanup();
				}
			};
			send('retry: 2500\n\n: connected\n\n');
			h.clients.add(send);
			const heartbeat = setInterval(() => send(': ping\n\n'), 20000);
			cleanup = () => {
				h.clients.delete(send);
				clearInterval(heartbeat);
				cleanup = () => {};
			};
			request.signal.addEventListener('abort', () => {
				cleanup();
				try {
					controller.close();
				} catch {}
			});
		},
		cancel() {
			cleanup();
		}
	});
	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
}

// Claude Code accepts aliases (resolve to the latest of a family) or full model IDs.
const CLAUDE_MODELS = [
	['best', 'Best available (alias)'],
	['opus', 'Opus — latest (alias)'],
	['sonnet', 'Sonnet — latest (alias)'],
	['haiku', 'Haiku — latest (alias)'],
	['opus[1m]', 'Opus 1M context (alias)'],
	['sonnet[1m]', 'Sonnet 1M context (alias)'],
	['opusplan', 'Opus plans, Sonnet executes (alias)'],
	['claude-fable-5-1', 'Claude Fable 5.1'],
	['claude-fable-5', 'Claude Fable 5'],
	['claude-opus-5-5', 'Claude Opus 5.5'],
	['claude-opus-5', 'Claude Opus 5'],
	['claude-opus-4-8', 'Claude Opus 4.8'],
	['claude-opus-4-7', 'Claude Opus 4.7'],
	['claude-opus-4-6', 'Claude Opus 4.6'],
	['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
	['claude-sonnet-5', 'Claude Sonnet 5'],
	['claude-sonnet-4-6', 'Claude Sonnet 4.6'],
	['claude-haiku-5-5', 'Claude Haiku 5.5'],
	['claude-haiku-4-5', 'Claude Haiku 4.5']
].map(([value, label]) => ({ value, label }));
export async function handleWrx({ request, url, route, userId, corpusWorkspaceId }) {
	try {
		const { store, engine, directory, terminals } = host(userId);
		const remote = !LOOPBACK.has(url.hostname);
		const raw = route.match(/^workspace-file\/([0-9a-f-]{36})$/);
		if (raw && (request.method === 'GET' || request.method === 'HEAD')) {
			try {
				return serveRaw(
					request,
					store.get('workspaces', raw[1]).path,
					url.searchParams.get('path') || ''
				);
			} catch (error) {
				return json(404, { error: error.message });
			}
		}
		const upload = route.match(
			/^uploads\/([0-9a-f-]{36})\/([0-9a-f-]{36}-\d+\.(png|jpg|gif|webp))$/
		);
		// Non-image attachments: always downloaded, never rendered inline.
		const attached = route.match(/^uploads\/([0-9a-f-]{36})\/([0-9a-f-]{36}-\d+)\/([^/]+)$/);
		if (attached && request.method === 'GET') {
			const name = attached[3]; // SvelteKit already decoded the path
			if (/[/\\]|^\.\.?$/.test(name)) return new Response('Not found', { status: 404 });
			const file = path.join(directory, 'uploads', attached[1], attached[2], name);
			if (!fs.existsSync(file)) return new Response('Not found', { status: 404 });
			return new Response(Readable.toWeb(fs.createReadStream(file)), {
				headers: {
					'Content-Type': 'application/octet-stream',
					'Content-Disposition': `attachment; filename="${name.replace(/[^\w.-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
					'X-Content-Type-Options': 'nosniff',
					'Cache-Control': 'private, max-age=86400',
					'Cross-Origin-Resource-Policy': 'same-origin'
				}
			});
		}
		if (upload && request.method === 'GET') {
			const file = path.join(directory, 'uploads', upload[1], upload[2]);
			if (!fs.existsSync(file)) return new Response('Not found', { status: 404 });
			return new Response(Readable.toWeb(fs.createReadStream(file)), {
				headers: {
					'Content-Type': {
						png: 'image/png',
						jpg: 'image/jpeg',
						gif: 'image/gif',
						webp: 'image/webp'
					}[upload[3]],
					'Cache-Control': 'private, max-age=86400',
					'Cross-Origin-Resource-Policy': 'same-origin'
				}
			});
		}
		if (request.method === 'GET') {
			if (route === 'models') {
				let codex = [];
				try {
					const cache = JSON.parse(
						fs.readFileSync(
							path.join(
								process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
								'models_cache.json'
							),
							'utf8'
						)
					);
					codex = (cache.models || [])
						.filter((m) => m.visibility === 'list' && typeof m.slug === 'string')
						.map((m) => ({ value: m.slug, label: m.display_name || m.slug }));
				} catch {}
				return json(200, {
					codex,
					claude: CLAUDE_MODELS
				});
			}
			if (route === 'mcp-servers')
				return json(200, await engine.mcpServers(url.searchParams.get('chatId')));
			if (route === 'state')
				return json(200, {
					...store.state,
					chats: clientChats(
						store.state.chats,
						url.searchParams.get('chat'),
						Number(url.searchParams.get('limit')) || undefined,
						url.searchParams.get('message')
					),
					tools: await tools(),
					machine,
					remote
				});
			if (route === 'network')
				return json(200, {
					machine,
					urls: addresses().map(
						(ip) => `${url.protocol}//${ip}${url.port ? `:${url.port}` : ''}/workbench`
					),
					local: !remote
				});
			if (route === 'directories')
				return json(200, await listDirectories(url.searchParams.get('path')));
			if (route === 'files')
				return json(
					200,
					await listDirectory(
						store.get('workspaces', url.searchParams.get('workspaceId')).path,
						url.searchParams.get('path') || ''
					)
				);
			if (route === 'file')
				return json(
					200,
					readFilePreview(
						store.get('workspaces', url.searchParams.get('workspaceId')).path,
						url.searchParams.get('path') || ''
					)
				);
			if (route === 'file-search')
				return json(
					200,
					await searchFiles(
						store.get('workspaces', url.searchParams.get('workspaceId')).path,
						url.searchParams.get('q')
					)
				);
			if (route === 'diff')
				return json(200, await engine.diff(url.searchParams.get('workspaceId')));
			if (route === 'commit-context')
				return json(200, await engine.commitContext(url.searchParams.get('workspaceId')));
			if (route === 'run-tasks')
				return json(200, engine.runTasks(url.searchParams.get('workspaceId')));
			if (route === 'run-log') return json(200, engine.runLog(url.searchParams.get('runId')));
			if (route === 'events') return events(hosts.get(userId), request);
			if (route === 'terminal-stream') {
				const w = store.get('workspaces', url.searchParams.get('workspaceId'));
				return terminalEvents(hosts.get(userId), w.id, request);
			}
		}
		if (request.method !== 'POST') return json(404, { error: 'Route not found' });
		const body = await readBody(request, route === 'turn' ? 48 * 1024 * 1024 : 100000);
		let result;
		switch (route) {
			case 'pick-directory':
				if (remote)
					return json(403, { error: 'Use the host folder browser when connected remotely' });
				result = await chooseDirectory();
				break;
			case 'projects':
				result = await engine.project(body);
				break;
			case 'workspaces':
				result = await engine.workspace(body);
				break;
			case 'workspace-config':
				result = await engine.workspaceConfig(body);
				break;
			case 'workspace-retry':
				result = engine.retryProvision(body.workspaceId);
				break;
			case 'workspace-database':
				result = engine.databaseAction(body.workspaceId, body.action, body.snapshot);
				break;
			case 'terminal-open': {
				const w = store.get('workspaces', body.workspaceId);
				if (!fs.statSync(w.path, { throwIfNoEntry: false })?.isDirectory())
					throw new Error(`This checkout is missing: ${w.path}`);
				const environment = w.environmentId ? store.get('environments', w.environmentId) : null;
				result = await terminals.open(w.id, {
					cwd: w.path,
					env: engine.workspaceEnv(w, environment),
					cols: body.cols,
					rows: body.rows
				});
				break;
			}
			case 'terminal-input':
				terminals.write(body.workspaceId, body.data);
				result = {};
				break;
			case 'terminal-resize':
				terminals.resize(body.workspaceId, body.cols, body.rows);
				result = {};
				break;
			case 'terminal-close':
				terminals.close(body.workspaceId);
				result = {};
				break;
			case 'workspace-delete':
				result = await engine.deleteWorkspace(body.workspaceId);
				break;
			case 'environment-delete':
				result = await engine.deleteEnvironment(body.environmentId);
				break;
			case 'project-delete':
				result = await engine.deleteProject(body.projectId);
				break;
			case 'chat-delete':
				result = engine.deleteChat(body.chatId);
				break;
			case 'environments':
				result = engine.environment(body);
				break;
			case 'attach':
				result = engine.attach(body.workspaceId, body.environmentId);
				break;
			case 'chats':
				result = engine.chat(body);
				result.corpusWorkspaceId = corpusWorkspaceId;
				break;
			case 'members':
				result = engine.addMember(body.chatId, body);
				break;
			case 'member':
				result = engine.updateMember(body.chatId, body.memberId, body);
				break;
			case 'chat':
				result = engine.updateChat(body.chatId, body);
				break;
			case 'member-remove':
				result = engine.removeMember(body.chatId, body.memberId);
				break;
			case 'turn':
				// Corpus tools act in the workspace the human last wrote from.
				store.get('chats', body.chatId).corpusWorkspaceId = corpusWorkspaceId;
				result = engine.turn(body.chatId, body.text, body.attachments ?? body.images);
				break;
			case 'cancel':
				engine.cancel(body.chatId);
				result = {};
				break;
			case 'runtime':
				result = engine.runtime(body.environmentId, body.action, body.workspaceId);
				break;
			case 'run-start':
				result = engine.runStart(body.workspaceId, body.taskId, body.variantId);
				break;
			case 'run-stop':
				result = engine.runStop(body.runId);
				break;
			case 'run-variant':
				result = engine.runVariantSave(body);
				break;
			case 'run-variant-delete':
				result = engine.runVariantDelete(body.workspaceId, body.variantId);
				break;
			case 'run-command':
				result = engine.runCommandSave(body);
				break;
			case 'run-command-delete':
				result = engine.runCommandDelete(body.workspaceId, body.commandId);
				break;
			case 'run-delete':
				result = engine.runDelete(body.runId);
				break;
			case 'run-clear':
				result = engine.runClear(body.workspaceId);
				break;
			case 'commit':
				result = await engine.commit(body.workspaceId, body.message);
				break;
			case 'tasks': {
				store.get('workspaces', body.workspaceId);
				result = {
					id: id(),
					workspaceId: body.workspaceId,
					title: requireText(body.title, 'Task title'),
					status: 'todo',
					createdAt: now()
				};
				store.state.tasks.push(result);
				engine.changed();
				break;
			}
			case 'task-status': {
				if (!['todo', 'doing', 'done'].includes(body.status))
					throw new Error('Invalid task status');
				result = store.get('tasks', body.id);
				result.status = body.status;
				// Lets the Corpus dashboard count workbench tasks in its completed-today stats.
				result.completedAt = body.status === 'done' ? (result.completedAt ?? now()) : null;
				engine.changed();
				break;
			}
			default:
				return json(404, { error: 'Route not found' });
		}
		// A removed workspace (or project) takes its terminal with it.
		for (const workspaceId of terminals.sessions.keys())
			if (!store.state.workspaces.some((w) => w.id === workspaceId)) terminals.close(workspaceId);
		return json(200, result);
	} catch (error) {
		return json(400, { error: error.message });
	}
}

// Refreshes Colima VM status for every loaded host (WRX probeRuntimes).
async function probeRuntimes() {
	const loaded = [...hosts.values()].filter((h) => h.store.state.environments.length);
	if (!loaded.length) return;
	let profiles;
	try {
		profiles = (await command('colima', ['list', '--json'], { timeout: 5000 }))
			.split('\n')
			.filter(Boolean)
			.flatMap((line) => {
				const item = JSON.parse(line);
				return Array.isArray(item) ? item : [item];
			});
	} catch {
		return;
	}
	for (const { store, engine } of loaded) {
		let changed = false;
		for (const e of store.state.environments) {
			if (e.busy) continue;
			const profile = profiles.find((p) => p.name === e.profile);
			const status = profile ? String(profile.status).toLowerCase() : 'not provisioned';
			if (e.status !== status) {
				e.status = status;
				changed = true;
			}
		}
		if (changed) engine.changed();
	}
}
if (!globalThis.__wrxProbe) {
	globalThis.__wrxProbe = setInterval(probeRuntimes, 15000);
	globalThis.__wrxProbe.unref();
}

// ----- Corpus MCP bridge (lib/server/mcp) -----

/** The agent holding this token, or null. Only tokens of live agent processes resolve. */
export function agentForToken(token) {
	for (const [userId, { engine }] of hosts) {
		const agent = engine.mcpAgent?.(token);
		if (agent) return { userId, ...agent };
	}
	return null;
}

/** Projects an agent can start a thread in, with their workspaces. */
export function knownProjects(userId) {
	const { projects, workspaces } = host(userId).store.state;
	return projects.map((p) => ({
		id: p.id,
		name: p.name,
		path: p.path,
		workspaces: workspaces
			.filter((w) => w.projectId === p.id)
			.map((w) => ({ id: w.id, name: w.name, branch: w.branch, primary: w.path === p.path }))
	}));
}

const MAX_SPAWNED = 5;
/**
 * Starts a one-agent thread for an agent. Only in known workspaces, never with full access, never
 * from a thread an agent started, and at most MAX_SPAWNED per parent thread.
 */
export function spawnThread(userId, parent, { workspaceId, title, prompt, provider, mode }) {
	const { engine, store } = host(userId);
	if (parent.spawnedBy) throw new Error('Threads started by an agent cannot start more threads');
	if (store.state.chats.filter((c) => c.spawnedBy === parent.id).length >= MAX_SPAWNED)
		throw new Error(`This thread already started ${MAX_SPAWNED} threads`);
	store.get('workspaces', workspaceId);
	requireText(prompt, 'Prompt', 20000);
	const chat = engine.chat({
		workspaceId,
		title,
		members: [{ provider, mode, name: 'Lead' }]
	});
	chat.spawnedBy = parent.id;
	chat.corpusWorkspaceId = parent.corpusWorkspaceId;
	engine.turn(chat.id, `Started by an agent in the thread “${parent.title}”:\n\n${prompt}`);
	return {
		chatId: chat.id,
		href: `/workbench?${new URLSearchParams({ workspace: workspaceId, tab: 'agents', chat: chat.id })}`
	};
}

// ----- Conductor bridge -----
// Conductor (lib/server/conductor.ts) hands tickets to Workbench: a worktree in each chosen repository
// and one agent thread (in the first; the rest are added as writable directories), then reads the
// thread back to see whether the agent finished. Same per-user host as the UI.

const expandHome = (p) => path.resolve(String(p).replace(/^~(?=\/|$)/, os.homedir()));

/**
 * The repositories Conductor can start in: `root` itself when it is a Git repository, otherwise the
 * Git repositories directly inside it (a folder of clones). Created when missing.
 */
export async function conductorRepos(root) {
	const dir = expandHome(root);
	fs.mkdirSync(dir, { recursive: true });
	const real = fs.realpathSync(dir);
	if ((await repositoryRoot(real).catch(() => null)) === real)
		return [{ path: real, name: path.basename(real) }];
	return fs
		.readdirSync(real, { withFileTypes: true })
		.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
		.map((e) => path.join(real, e.name))
		.filter((p) => fs.existsSync(path.join(p, '.git')))
		.sort((a, b) => a.localeCompare(b))
		.map((p) => ({ path: p, name: path.basename(p) }));
}

async function conductorWorkspace(engine, store, repoPath, { branch, title }) {
	const directory = fs.realpathSync(expandHome(repoPath));
	const root = (await repositoryRoot(directory).catch(() => null)) ?? directory;
	let project = store.state.projects.find((p) => p.path === root);
	if (!project) project = await engine.project({ path: root });
	if (project.folder) {
		const w = store.state.workspaces.find((x) => x.projectId === project.id && x.path === root);
		return {
			workspace: w,
			repo: { workspaceId: w.id, path: root, name: project.name, branch: null, base: null }
		};
	}
	const base =
		(await command('git', ['-C', root, 'branch', '--show-current']).catch(() => '')) || null;
	const w = await engine.workspace({
		projectId: project.id,
		name: title.slice(0, 60),
		branch,
		base: base ?? 'HEAD'
	});
	return {
		workspace: w,
		repo: { workspaceId: w.id, path: root, name: project.name, branch, base }
	};
}

/**
 * Starts the ticket's thread. `repoPaths` get a worktree each (or `workspaceIds` are reused when the
 * previous thread was removed); the first is the thread's workspace.
 * @param {string} userId
 * @param {{ repoPaths?: string[]; workspaceIds?: string[]; branch: string; title: string; prompt: string; team: { provider: string; mode: string; name: string; role: string; model?: string; fullAccess?: boolean }[] }} input
 */
export async function conductorStart(
	userId,
	{ repoPaths = [], workspaceIds = [], branch, title, prompt, team }
) {
	const { engine, store } = host(userId);
	let workspaces;
	let repos = null;
	const reuse = workspaceIds.map((id) => store.state.workspaces.find((w) => w.id === id));
	if (workspaceIds.length && reuse.every(Boolean)) {
		workspaces = reuse;
	} else {
		if (!repoPaths.length) throw new Error('Choose a repository');
		const made = [];
		for (const p of repoPaths)
			made.push(await conductorWorkspace(engine, store, p, { branch, title }));
		workspaces = made.map((m) => m.workspace);
		repos = made.map((m) => m.repo);
	}
	const chat = engine.chat({
		workspaceId: workspaces[0].id,
		title: title.slice(0, 200),
		members: team
	});
	// Ticket agents read text other people wrote, so they don't get the user's calendar, notes or board.
	chat.corpusTools = false;
	if (workspaces.length > 1) chat.extraDirs = workspaces.slice(1).map((w) => w.path);
	engine.turn(chat.id, prompt);
	return { chatId: chat.id, repos };
}

/** Where a Conductor thread stands, or null when it no longer exists. Never changes state. */
export function conductorChat(userId, chatId) {
	if (!hosts.has(userId) && !fs.existsSync(path.join(userDirectory(userId), 'state.json')))
		return null;
	const { engine, store } = host(userId);
	const chat = store.state.chats.find((c) => c.id === chatId);
	if (!chat) return null;
	const last = [...chat.messages]
		.reverse()
		.find((m) => m.role === 'agent' && m.status !== 'running');
	return {
		status: chat.status,
		running: engine.chatRunning(chatId) || engine.queue.some((j) => j.chatId === chatId),
		error: chat.error ?? null,
		workspaceId: chat.workspaceId,
		lastAgentText: last?.text ?? null,
		lastAgentAt: last?.at ?? null,
		lastAgentName: chat.members.find((m) => m.id === last?.memberId)?.name ?? null
	};
}

/** Posts the user's note into the thread, which wakes its lead agent. */
export function conductorSend(userId, chatId, text) {
	host(userId).engine.turn(chatId, text);
}

/**
 * Commits and pushes what the agent left in one worktree. `changed: false` when the branch has nothing
 * beyond its base, so a repository the agent didn't touch gets no PR.
 */
export async function conductorPush(userId, workspaceId, message, base) {
	const { engine, store } = host(userId);
	const w = store.get('workspaces', workspaceId);
	const git = (args, timeout = 120000) =>
		command('git', args, {
			cwd: w.path,
			timeout,
			env: { ...agentEnv(), GIT_TERMINAL_PROMPT: '0' }
		});
	const remote = await git(['remote', 'get-url', 'origin']).catch(() => '');
	const result = { repo: githubRepo(remote), branch: w.branch, changed: true };
	if (await git(['status', '--porcelain']).catch(() => '')) {
		const r = await engine.commit(workspaceId, message);
		if (!r.pushed) throw new Error(r.reason || 'Push failed');
		return result;
	}
	const ahead = Number(
		await git(['rev-list', '--count', `${base || 'HEAD@{upstream}'}..HEAD`]).catch(() => '1')
	);
	if (!ahead) return { ...result, changed: false };
	// The agent may have committed itself; make sure the branch is on the remote.
	await git(['push', '-u', 'origin', 'HEAD'], 180000);
	return result;
}

/** The branch's changes against its base, for writing the PR description. Read-only. */
export async function conductorDiff(userId, workspaceId, base) {
	const w = host(userId).store.get('workspaces', workspaceId);
	const range = `${base || 'HEAD@{upstream}'}...HEAD`;
	const git = (args) => command('git', args, { cwd: w.path, timeout: 30000 }).catch(() => '');
	const [stat, log, diff] = await Promise.all([
		git(['diff', '--stat', range]),
		git(['log', '--format=%s', range]),
		git(['diff', range])
	]);
	return { stat, log, diff };
}
