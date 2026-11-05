/* eslint-disable @typescript-eslint/ban-ts-comment -- plain JS, like the rest of wrx */
// @ts-nocheck — plain JS, like the rest of wrx.
// Makes a new Workbench worktree runnable for any repository, driven by the .workbench.json the
// repository commits: gitignored paths, ports, env values, shared services, a database of its own.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

export const CONFIG_FILE = '.workbench.json';
const CONFIG_KEYS = [
	'copy',
	'clone',
	'share',
	'ports',
	'env',
	'envFile',
	'services',
	'database',
	'scripts'
];
const DATABASE_KEYS = ['engine', 'urlEnv', 'source', 'service', 'seed', 'excludeData', 'migrate'];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const LOG_LIMIT = 80000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
// A template over this size is copied at the filesystem level, which is also what lets a Postgres 18
// server with file_copy_method = clone share blocks instead of copying them.
const FILE_COPY_THRESHOLD = 1024 ** 3;

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

function relativePath(value, label) {
	if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a path`);
	const clean = path.posix.normalize(value.trim()).replace(/\/$/, '');
	if (
		path.isAbsolute(clean) ||
		clean === '.' ||
		clean === '..' ||
		clean.startsWith('../') ||
		clean === '.git' ||
		clean.startsWith('.git/')
	)
		throw new Error(`${label} must stay inside the repository: ${value}`);
	return clean;
}

function pathList(value, label) {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`${label} must be an array of paths`);
	return value.map((p) => relativePath(p, label));
}

function unknownKeys(value, allowed, label) {
	for (const key of Object.keys(value))
		if (!allowed.includes(key)) throw new Error(`Unknown ${label} key "${key}"`);
}

/** Connection parts of a database URL. Only local servers: a repo .env must never reach production. */
export function parseSource(source) {
	let url;
	try {
		url = new URL(source);
	} catch {
		throw new Error('database.source must be a postgres:// URL');
	}
	if (!['postgres:', 'postgresql:'].includes(url.protocol))
		throw new Error('database.source must be a postgres:// URL');
	if (!LOCAL_HOSTS.has(url.hostname))
		throw new Error(`Refusing database.source on non-local host "${url.hostname}"`);
	const database = decodeURIComponent(url.pathname.slice(1));
	if (!database) throw new Error('database.source must name a database');
	return {
		url,
		database,
		host: url.hostname.replace(/^\[|\]$/g, ''),
		port: url.port || '5432',
		user: decodeURIComponent(url.username) || 'postgres',
		password: decodeURIComponent(url.password)
	};
}

function parseDatabase(value) {
	if (!isObject(value)) throw new Error('database must be an object');
	unknownKeys(value, DATABASE_KEYS, 'database');
	if (value.engine !== 'postgres') throw new Error('database.engine must be "postgres"');
	const urlEnv = value.urlEnv ?? 'DATABASE_URL';
	if (!ENV_NAME.test(urlEnv)) throw new Error('database.urlEnv must be an env var name');
	if (typeof value.source !== 'string') throw new Error('database.source is required');
	parseSource(value.source);
	if (value.service !== undefined && !SERVICE_NAME.test(String(value.service)))
		throw new Error('database.service must be a Compose service name');
	const seed = value.seed ?? 'clone';
	if (!['clone', 'blank'].includes(seed))
		throw new Error('database.seed must be "clone" or "blank"');
	const excludeData = value.excludeData ?? [];
	if (
		!Array.isArray(excludeData) ||
		excludeData.some((t) => typeof t !== 'string' || !/^[\w.*"$-]+$/.test(t))
	)
		throw new Error('database.excludeData must be an array of table patterns');
	if (value.migrate !== undefined && typeof value.migrate !== 'string')
		throw new Error('database.migrate must be a command');
	return {
		engine: 'postgres',
		urlEnv,
		source: value.source,
		service: value.service,
		seed,
		excludeData,
		migrate: value.migrate || ''
	};
}

/** Validates .workbench.json text. Throws on anything it doesn't understand, typos included. */
export function parseConfig(raw) {
	let value;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		throw new Error(`${CONFIG_FILE} is not valid JSON: ${error.message}`, { cause: error });
	}
	try {
		if (!isObject(value)) throw new Error('expected an object');
		unknownKeys(value, CONFIG_KEYS, 'top-level');
		const ports = value.ports ?? {};
		const env = value.env ?? {};
		const scripts = value.scripts ?? {};
		const services = value.services ?? {};
		if (!isObject(ports) || !isObject(env) || !isObject(scripts) || !isObject(services))
			throw new Error('ports, env, scripts and services must be objects');
		const portNames = Object.keys(ports);
		if (portNames.length > PORT_BLOCK) throw new Error(`at most ${PORT_BLOCK} ports are supported`);
		for (const [name, variable] of Object.entries(ports))
			if (!ENV_NAME.test(name) || !ENV_NAME.test(String(variable)))
				throw new Error(`ports.${name} must map a name to an env var name`);
		for (const [name, text] of Object.entries(env))
			if (!ENV_NAME.test(name) || typeof text !== 'string')
				throw new Error(`env.${name} must be a string`);
		unknownKeys(scripts, ['setup', 'teardown'], 'scripts');
		for (const [name, text] of Object.entries(scripts))
			if (typeof text !== 'string') throw new Error(`scripts.${name} must be a command`);
		unknownKeys(services, ['compose', 'shared'], 'services');
		const shared = services.shared ?? [];
		if (!Array.isArray(shared) || shared.some((s) => !SERVICE_NAME.test(String(s))))
			throw new Error('services.shared must be an array of Compose service names');
		return {
			copy: pathList(value.copy, 'copy'),
			clone: pathList(value.clone, 'clone'),
			share: pathList(value.share, 'share'),
			ports,
			env,
			envFile: value.envFile ? relativePath(value.envFile, 'envFile') : '',
			services: {
				compose: services.compose ? relativePath(services.compose, 'services.compose') : '',
				shared
			},
			database: value.database ? parseDatabase(value.database) : null,
			scripts: { setup: scripts.setup || '', teardown: scripts.teardown || '' }
		};
	} catch (error) {
		throw new Error(`Invalid ${CONFIG_FILE}: ${error.message}`, { cause: error });
	}
}

/**
 * The config committed at a ref, or null when that ref has none. Read from git rather than a
 * checkout so that what gets approved is exactly what the new worktree will contain.
 */
export async function readRepoConfig(repository, ref, env = process.env) {
	let raw;
	try {
		raw = await run('git', ['-C', repository, 'show', `${ref}:${CONFIG_FILE}`], {
			env,
			timeout: 15000
		});
	} catch {
		return null;
	}
	return { config: parseConfig(raw), hash: createHash('sha256').update(raw).digest('hex') };
}

/** Everything a config will execute on the host: what a person must approve before it runs. */
export function configCommands(config) {
	return [
		config.scripts.setup && ['Setup', config.scripts.setup],
		config.database?.migrate && ['Migrate', config.database.migrate],
		config.scripts.teardown && ['Teardown', config.scripts.teardown],
		config.services.shared.length && [
			'Compose services',
			`docker compose up -d --wait ${config.services.shared.join(' ')}`
		],
		config.database && [
			'Database source',
			`Reads ${parseSource(config.database.source).database} on the local server`
		]
	].filter(Boolean);
}

/** Runs a process and resolves with stdout. Stderr goes to `log`, and to the rejection message. */
export function run(bin, args, { cwd, env, log, timeout = 300000, stream = false } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (data) => {
			stdout = (stdout + data).slice(-LOG_LIMIT);
			if (stream) log?.(data);
		});
		child.stderr.on('data', (data) => {
			stderr = (stderr + data).slice(-4000);
			log?.(data);
		});
		child.on('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on('close', (code, signal) => {
			clearTimeout(timer);
			if (code === 0) resolve(stdout.trim());
			else
				reject(
					new Error(
						stderr.trim().split('\n').slice(-3).join(' ') ||
							`${bin} exited with ${signal || `code ${code}`}`
					)
				);
		});
	});
}

export const runShell = (script, options) =>
	run('sh', ['-c', script], { timeout: 30 * 60000, stream: true, ...options });

const ignored = (root, relative, env) =>
	run('git', ['-C', root, 'check-ignore', '-q', relative], { env, timeout: 15000 }).then(
		() => true,
		() => false
	);

async function cloneTree(from, to, env) {
	const args = process.platform === 'darwin' ? ['-cR'] : ['-R', '--reflink=auto'];
	try {
		await run('cp', [...args, from, to], { env, timeout: 30 * 60000 });
	} catch {
		// Clones need one volume and a filesystem that supports them.
		fs.rmSync(to, { recursive: true, force: true });
		await fs.promises.cp(from, to, { recursive: true, verbatimSymlinks: true });
	}
}

/**
 * Fills a fresh checkout with the gitignored paths the config lists. Tracked paths are skipped: git
 * already handles them, and overwriting one would dirty the worktree. Paths already there are kept,
 * so a retry is safe.
 */
export async function applyPaths(
	config,
	primary,
	worktree,
	{ log = () => {}, env = process.env } = {}
) {
	const groups = [
		['copy', config.copy],
		['clone', config.clone],
		['share', config.share]
	];
	for (const [kind, list] of groups)
		for (const relative of list) {
			const from = path.join(primary, relative);
			const to = path.join(worktree, relative);
			if (!fs.existsSync(from)) {
				log(`${kind}: ${relative} not in the primary checkout, skipped\n`);
				continue;
			}
			if (!(await ignored(primary, relative, env))) {
				log(`${kind}: ${relative} is not gitignored, skipped\n`);
				continue;
			}
			if (fs.existsSync(to)) continue;
			fs.mkdirSync(path.dirname(to), { recursive: true });
			if (kind === 'share') fs.symlinkSync(from, to);
			else if (kind === 'clone') await cloneTree(from, to, env);
			else await fs.promises.cp(from, to, { recursive: true, verbatimSymlinks: true });
			log(`${kind}: ${relative}\n`);
		}
}

const PORT_START = 20000;
const PORT_END = 40000;
export const PORT_BLOCK = 10;

const portFree = (port) =>
	new Promise((resolve) => {
		const server = net.createServer();
		server.once('error', () => resolve(false));
		server.listen(port, () => server.close(() => resolve(true)));
	});

/** Lowest free block of ports: not held by another workspace and actually bindable right now. */
export async function allocatePorts(names, takenSlots) {
	const taken = new Set(takenSlots);
	for (let slot = 0; PORT_START + (slot + 1) * PORT_BLOCK <= PORT_END; slot++) {
		if (taken.has(slot)) continue;
		const ports = Object.fromEntries(
			names.map((name, i) => [name, PORT_START + slot * PORT_BLOCK + i])
		);
		const free = await Promise.all(Object.values(ports).map(portFree));
		if (free.every(Boolean)) return { slot, ports };
	}
	throw new Error('No free port block between 20000 and 40000');
}

/** Env values for a workspace: allocated ports, the database URL and the config's `env` templates. */
export function renderEnv(config, values) {
	const out = {};
	for (const [name, variable] of Object.entries(config.ports))
		out[variable] = String(values.ports[name]);
	if (config.database && values.databaseUrl) out[config.database.urlEnv] = values.databaseUrl;
	const scope = {
		'database.url': values.databaseUrl || '',
		'workspace.id': values.workspace.id,
		'workspace.name': values.workspace.name,
		'workspace.branch': values.workspace.branch,
		'workspace.path': values.workspace.path,
		...Object.fromEntries(
			Object.entries(values.ports).map(([name, port]) => [`ports.${name}`, String(port)])
		)
	};
	for (const [name, template] of Object.entries(config.env))
		out[name] = template.replace(/\$\{([^}]+)\}/g, (_, key) => {
			if (!(key in scope)) throw new Error(`env.${name} uses unknown \${${key}}`);
			return scope[key];
		});
	return out;
}

/** Sets keys in a dotenv file: replaces each existing line, appends the rest, keeps everything else. */
export function writeEnvFile(file, values) {
	const quote = (v) => (/^[\w@%+=:,./-]*$/.test(v) ? v : JSON.stringify(v));
	const pending = new Map(Object.entries(values));
	const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
	const next = lines.map((line) => {
		const key = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
		if (!key || !pending.has(key)) return line;
		const value = pending.get(key);
		pending.delete(key);
		return `${key}=${quote(value)}`;
	});
	while (next.length && !next[next.length - 1]) next.pop();
	for (const [key, value] of pending) next.push(`${key}=${quote(value)}`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${next.join('\n')}\n`, { mode: 0o600 });
}

export async function assertEnvFileIgnored(worktree, relative, env) {
	if (!(await ignored(worktree, relative, env)))
		throw new Error(
			`envFile ${relative} must be gitignored, or writing it would dirty the worktree`
		);
}

/** Directory holding a project's worktrees. Outside any repository so upward config searches stop. */
export function worktreesDirectory(project, env = process.env) {
	const root = env.WRX_WORKTREES || path.join(os.homedir(), '.workbench', 'worktrees');
	return path.join(path.resolve(root), `${slug(project.name)}-${project.id.slice(0, 8)}`);
}

export function slug(text) {
	return (
		String(text)
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40) || 'workspace'
	);
}

/** Starts the repo's shared services from the primary checkout, under Compose's default project name
 * so containers the developer already runs there are reused instead of duplicated. */
export function startServices(config, primary, { log, env } = {}) {
	if (!config.services.shared.length) return;
	const file = config.services.compose ? ['-f', config.services.compose] : [];
	return run('docker', ['compose', ...file, 'up', '-d', '--wait', ...config.services.shared], {
		cwd: primary,
		env,
		log,
		timeout: 10 * 60000,
		stream: true
	});
}

const MANAGED = /^wb_[a-z0-9_]{1,60}$/;
function managed(name) {
	if (!MANAGED.test(name)) throw new Error(`Refusing to touch unmanaged database "${name}"`);
	return `"${name}"`;
}
const shortId = (id) => {
	const short = String(id).replace(/-/g, '').slice(0, 8).toLowerCase();
	if (!/^[0-9a-f]{8}$/.test(short)) throw new Error('Invalid database id');
	return short;
};
export const baseDatabase = (projectId) => `wb_base_${shortId(projectId)}`;
export const workspaceDatabase = (workspaceId) => `wb_${shortId(workspaceId)}`;
export const snapshotDatabase = (workspaceId, n) =>
	`${workspaceDatabase(workspaceId)}_s_${Number(n)}`;

/**
 * Per-worktree databases on one local Postgres server. A golden template that nothing connects to
 * is built from the source with pg_dump, so the developer's running app is never disconnected, and
 * worktrees are cloned from it with CREATE DATABASE ... TEMPLATE.
 */
export class Postgres {
	constructor(config, primary, { log = () => {}, env = process.env } = {}) {
		this.database = config.database;
		this.compose = config.services.compose;
		this.primary = primary;
		this.log = log;
		this.env = env;
		this.source = parseSource(this.database.source);
	}
	tool(name, database, args) {
		const { host, port, user, password } = this.source;
		const env = { ...this.env, PGPASSWORD: password };
		// `-e PGPASSWORD` forwards the value from this process's env, keeping it out of the arguments.
		if (this.database.service) {
			const file = this.compose ? ['-f', this.compose] : [];
			return {
				bin: 'docker',
				args: [
					'compose',
					...file,
					'exec',
					'-T',
					'-e',
					'PGPASSWORD',
					this.database.service,
					name,
					'-h',
					'127.0.0.1',
					'-U',
					user,
					'-d',
					database,
					...args
				],
				env
			};
		}
		return { bin: name, args: ['-h', host, '-p', port, '-U', user, '-d', database, ...args], env };
	}
	/** Runs SQL against the source database, which is never used as a template. */
	sql(statement, database = this.source.database) {
		const { bin, args, env } = this.tool('psql', database, [
			'-X',
			'-At',
			'-v',
			'ON_ERROR_STOP=1',
			'-c',
			statement
		]);
		return run(bin, args, { cwd: this.primary, env, timeout: 60 * 60000 });
	}
	urlFor(name) {
		const url = new URL(this.source.url);
		url.pathname = `/${name}`;
		return url.toString();
	}
	async exists(name) {
		managed(name);
		return (await this.sql(`select 1 from pg_database where datname = '${name}'`)) === '1';
	}
	async drop(name) {
		await this.sql(`drop database if exists ${managed(name)} with (force)`);
	}
	async allowConnections(name, allow) {
		await this.sql(`alter database ${managed(name)} allow_connections ${allow}`);
	}
	async createEmpty(name) {
		await this.sql(`create database ${managed(name)}`);
	}
	async clone(from, to) {
		const [version, size, method] = (
			await this.sql(
				`select current_setting('server_version_num')::int || '|' || pg_database_size('${managed(from).slice(1, -1)}') || '|' || coalesce(current_setting('file_copy_method', true), '')`
			)
		).split('|');
		const fileCopy = Number(version) >= 150000 && Number(size) > FILE_COPY_THRESHOLD;
		if (fileCopy)
			this.log(
				method.toLowerCase() === 'clone'
					? 'Large template: copying with FILE_COPY, file_copy_method = clone.\n'
					: 'Large template: copying with FILE_COPY. Postgres 18 with file_copy_method = clone on a reflink filesystem can share blocks instead.\n'
			);
		await this.sql(
			`create database ${managed(to)} template ${managed(from)}${fileCopy ? ' strategy file_copy' : ''}`
		);
	}
	/** Clones a database apps may be using: blocks and removes its connections for the copy. */
	async cloneLive(from, to) {
		await this.allowConnections(from, false);
		try {
			await this.sql(
				`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${managed(from).slice(1, -1)}' and pid <> pg_backend_pid()`
			);
			await this.clone(from, to);
		} finally {
			await this.allowConnections(from, true);
		}
	}
	/** Builds under a temporary name so a failed dump can't leave a half-filled template behind. */
	async buildBase(name) {
		const building = `${name}_new`;
		await this.drop(building);
		await this.createEmpty(building);
		try {
			await this.copySource(building);
			await this.drop(name);
			await this.sql(`alter database ${managed(building)} rename to ${managed(name)}`);
			await this.allowConnections(name, false);
		} catch (error) {
			await this.drop(building).catch(() => {});
			throw error;
		}
	}
	copySource(target) {
		const exclude = this.database.excludeData.map((t) => `--exclude-table-data=${t}`);
		const dump = this.tool('pg_dump', this.source.database, [
			'--no-owner',
			'--no-privileges',
			...exclude
		]);
		const load = this.tool('psql', target, ['-X', '-q', '-v', 'ON_ERROR_STOP=1']);
		return new Promise((resolve, reject) => {
			const dumper = spawn(dump.bin, dump.args, {
				cwd: this.primary,
				env: dump.env,
				stdio: ['ignore', 'pipe', 'pipe']
			});
			const loader = spawn(load.bin, load.args, {
				cwd: this.primary,
				env: load.env,
				stdio: ['pipe', 'ignore', 'pipe']
			});
			let stderr = '';
			const capture = (data) => {
				stderr = (stderr + data).slice(-4000);
				this.log(String(data));
			};
			dumper.stderr.on('data', capture);
			loader.stderr.on('data', capture);
			// The loader stopping early surfaces through its exit code, not this write error.
			loader.stdin.on('error', () => {});
			dumper.stdout.pipe(loader.stdin);
			const exited = (child, name) =>
				new Promise((done, fail) => {
					child.on('error', fail);
					child.on('close', (code) =>
						code === 0
							? done()
							: fail(new Error(stderr.trim().split('\n').slice(-3).join(' ') || `${name} failed`))
					);
				});
			Promise.all([exited(dumper, 'pg_dump'), exited(loader, 'psql')]).then(resolve, reject);
		});
	}
	/** Names of this workspace's database and its snapshots that exist on the server. */
	async owned(workspaceId) {
		const db = workspaceDatabase(workspaceId);
		const rows = await this.sql(
			`select datname from pg_database where datname ~ '^${db}(_s_[0-9]+)?$'`
		);
		return rows.split('\n').filter(Boolean);
	}
}
