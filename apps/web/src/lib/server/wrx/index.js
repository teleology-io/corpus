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
import { Store, Engine, command, agentEnv, id, now, requireText } from './core.js';

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
	if (h) return h;
	const directory = userDirectory(userId);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	lockDirectory(directory);
	const store = new Store(directory);
	const clients = new Set();
	const engine = new Engine(store, () => {
		for (const send of clients) send('event: change\ndata: {}\n\n');
	});
	h = { directory, store, engine, clients };
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
					href
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
export async function handleWrx({ request, url, route, userId }) {
	try {
		const { store, engine, directory } = host(userId);
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
			if (route === 'state')
				return json(200, { ...store.state, tools: await tools(), machine, remote });
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
			if (route === 'run-tasks')
				return json(200, engine.runTasks(url.searchParams.get('workspaceId')));
			if (route === 'run-log') return json(200, engine.runLog(url.searchParams.get('runId')));
			if (route === 'events') return events(hosts.get(userId), request);
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
				break;
			case 'members':
				result = engine.addMember(body.chatId, body);
				break;
			case 'member':
				result = engine.updateMember(body.chatId, body.memberId, body);
				break;
			case 'member-remove':
				result = engine.removeMember(body.chatId, body.memberId);
				break;
			case 'turn':
				result = engine.turn(body.chatId, body.text, body.images);
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
