import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadedEnvKeys } from '@corpus/db/env';
import { Engine, Store, agentEnv, hostEnv } from '../../src/lib/server/wrx/core.js';
import {
	PORT_BLOCK,
	Postgres,
	allocatePorts,
	applyPaths,
	baseDatabase,
	parseConfig,
	parseSource,
	renderEnv,
	writeEnvFile
} from '../../src/lib/server/wrx/provision.js';

const git = (cwd: string, ...args: string[]) =>
	execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

const source = 'postgres://app:secret@localhost:5432/app';

describe('parseConfig', () => {
	it('fills defaults for a minimal config', () => {
		const config = parseConfig('{}');
		expect(config.copy).toEqual([]);
		expect(config.database).toBeNull();
		expect(config.scripts).toEqual({ setup: '', teardown: '' });
	});

	it('rejects typos, escaping paths and invalid values', () => {
		for (const raw of [
			'not json',
			'{"sharedDirs": []}',
			'{"copy": ["../secrets"]}',
			'{"copy": ["/etc/passwd"]}',
			'{"clone": [".git/config"]}',
			'{"envFile": "../.env"}',
			'{"ports": {"web": "not a var"}}',
			'{"scripts": {"archive": "x"}}',
			'{"database": {"engine": "mysql", "source": "x"}}',
			`{"database": {"engine": "postgres", "source": "${source}", "seed": "dump"}}`,
			`{"database": {"engine": "postgres", "source": "${source}", "excludeData": ["a b"]}}`
		])
			expect(() => parseConfig(raw), raw).toThrow();
	});

	it('refuses a database source that is not on this machine', () => {
		const raw = (url: string) => JSON.stringify({ database: { engine: 'postgres', source: url } });
		expect(() => parseConfig(raw('postgres://app:x@db.example.com:5432/app'))).toThrow(/non-local/);
		expect(parseConfig(raw('postgres://app:x@127.0.0.1:5432/app')).database?.urlEnv).toBe(
			'DATABASE_URL'
		);
		expect(parseSource('postgres://a:b%40c@[::1]:6000/x')).toMatchObject({
			host: '::1',
			port: '6000',
			password: 'b@c',
			database: 'x'
		});
	});
});

describe('Postgres', () => {
	it('never touches a database outside the wb_ namespace', async () => {
		const pg = new Postgres(
			parseConfig(JSON.stringify({ database: { engine: 'postgres', source } })),
			os.tmpdir()
		);
		pg.sql = vi.fn(async () => '');
		for (const name of ['app', 'postgres', 'wb_x"; drop database app; --', 'WB_ABC', 'wb_'])
			await expect(pg.drop(name), name).rejects.toThrow(/unmanaged/);
		expect(pg.sql).not.toHaveBeenCalled();
		await pg.drop('wb_12345678');
		expect(pg.sql).toHaveBeenCalledOnce();
	});

	it('points clones at the same server under their own name', () => {
		const pg = new Postgres(
			parseConfig(JSON.stringify({ database: { engine: 'postgres', source } })),
			os.tmpdir()
		);
		expect(pg.urlFor('wb_12345678')).toBe('postgres://app:secret@localhost:5432/wb_12345678');
		expect(baseDatabase('abcdef12-0000-0000-0000-000000000000')).toBe('wb_base_abcdef12');
	});
});

describe('allocatePorts', () => {
	it('skips blocks held by workspaces and blocks with a port already bound', async () => {
		const blocker = net.createServer();
		const bound = 20000 + PORT_BLOCK;
		await new Promise<void>((resolve) => blocker.listen(bound, () => resolve()));
		try {
			const { slot, ports } = await allocatePorts(['web', 'api'], [0]);
			expect(slot).toBeGreaterThanOrEqual(2);
			expect(ports).toEqual({ web: 20000 + slot * PORT_BLOCK, api: 20000 + slot * PORT_BLOCK + 1 });
		} finally {
			await new Promise((resolve) => blocker.close(resolve));
		}
	});
});

describe('renderEnv and writeEnvFile', () => {
	const workspace = { id: 'id', name: 'n', branch: 'b', path: '/p' };

	it('renders port, database and template values', () => {
		const config = parseConfig(
			JSON.stringify({
				ports: { web: 'PORT' },
				env: { PUBLIC_URL: 'http://localhost:${ports.web}/${workspace.branch}' },
				database: { engine: 'postgres', source }
			})
		);
		expect(renderEnv(config, { ports: { web: 20010 }, databaseUrl: 'pg://x', workspace })).toEqual({
			PORT: '20010',
			DATABASE_URL: 'pg://x',
			PUBLIC_URL: 'http://localhost:20010/b'
		});
	});

	it('rejects unknown template variables', () => {
		const config = parseConfig(JSON.stringify({ env: { A: '${nope}' } }));
		expect(() => renderEnv(config, { ports: {}, workspace })).toThrow(/unknown/);
	});

	it('replaces matching lines, appends the rest and keeps everything else', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-env-'));
		const file = path.join(dir, '.env');
		fs.writeFileSync(file, '# comment\nKEEP=1\nexport PORT=3000\nDATABASE_URL=old\n');
		writeEnvFile(file, { PORT: '20000', DATABASE_URL: 'postgres://a:b@c/d', NOTE: 'two words' });
		expect(fs.readFileSync(file, 'utf8')).toBe(
			'# comment\nKEEP=1\nPORT=20000\nDATABASE_URL=postgres://a:b@c/d\nNOTE="two words"\n'
		);
		fs.rmSync(dir, { recursive: true });
	});
});

describe('agent environment', () => {
	it("removes keys from the app's own .env but keeps host essentials", () => {
		const keys = loadedEnvKeys() as Set<string>;
		keys.add('DATABASE_URL');
		keys.add('PATH');
		try {
			const env = { DATABASE_URL: 'corpus', PATH: '/bin', OTHER: 'kept' };
			expect(hostEnv(env)).toEqual({ PATH: '/bin', OTHER: 'kept' });
			expect(agentEnv(env).DATABASE_URL).toBeUndefined();
			expect(agentEnv(env).PATH).toContain('/bin');
		} finally {
			keys.delete('DATABASE_URL');
			keys.delete('PATH');
		}
	});
});

describe('workspaces from a repository config', () => {
	let dir: string;
	let repo: string;
	let engine: Engine;
	let projectId: string;
	let previous: string | undefined;

	const until = async (check: () => boolean) => {
		for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 25));
		expect(check()).toBe(true);
	};
	const commitConfig = (config: object) => {
		fs.writeFileSync(path.join(repo, '.workbench.json'), JSON.stringify(config));
		git(repo, 'add', '.');
		git(repo, 'commit', '-qm', 'config');
	};

	beforeEach(async () => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-provision-')));
		previous = process.env.WRX_WORKTREES;
		process.env.WRX_WORKTREES = path.join(dir, 'worktrees');
		repo = path.join(dir, 'repo');
		fs.mkdirSync(repo);
		git(repo, 'init', '-q', '-b', 'trunk');
		git(repo, 'config', 'user.email', 'test@example.com');
		git(repo, 'config', 'user.name', 'Test');
		fs.writeFileSync(path.join(repo, '.gitignore'), '.env\ncache/\n');
		fs.writeFileSync(path.join(repo, 'tracked.txt'), 'hello\n');
		fs.writeFileSync(path.join(repo, '.env'), 'FROM_PRIMARY=1\nPORT=3000\n');
		fs.mkdirSync(path.join(repo, 'cache'));
		fs.writeFileSync(path.join(repo, 'cache', 'blob'), 'cached');
		git(repo, 'add', '.');
		git(repo, 'commit', '-qm', 'init');
		engine = new Engine(new Store(path.join(dir, 'state')));
		projectId = (await engine.project({ path: repo })).id;
	});

	afterEach(() => {
		if (engine.changeTimer) clearTimeout(engine.changeTimer);
		engine.changeTimer = null;
		if (previous === undefined) delete process.env.WRX_WORKTREES;
		else process.env.WRX_WORKTREES = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const create = (name: string, extra = {}) =>
		engine.workspace({ projectId, name, branch: `feat/${name}`, base: 'trunk', ...extra });

	it('creates worktrees outside the repository with no config, as before', async () => {
		const w = await create('plain');
		expect(w.provision).toBeUndefined();
		expect(w.path.startsWith(path.join(dir, 'worktrees'))).toBe(true);
		expect(fs.existsSync(path.join(w.path, 'tracked.txt'))).toBe(true);
	});

	it('refuses to run a config until that exact version is approved', async () => {
		commitConfig({ scripts: { setup: 'touch ran' } });
		await expect(create('a')).rejects.toThrow(/Approve/);
		const preview = await engine.workspaceConfig({ projectId, base: 'trunk' });
		expect(preview).toMatchObject({ found: true, trusted: false });
		expect(preview.commands).toEqual([['Setup', 'touch ran']]);
		const w = await create('a', { trustConfigHash: preview.hash });
		await until(() => w.provision.status !== 'running');
		expect(w.provision.status).toBe('ready');

		// Approved once: the same config needs no second approval, a changed one does.
		expect((await engine.workspaceConfig({ projectId, base: 'trunk' })).trusted).toBe(true);
		commitConfig({ scripts: { setup: 'touch other' } });
		await expect(create('b')).rejects.toThrow(/Approve/);
	});

	it('provisions paths, ports and env, then removes it all but the branch', async () => {
		commitConfig({
			copy: ['.env'],
			clone: ['cache'],
			ports: { web: 'PORT' },
			env: { PUBLIC_URL: 'http://localhost:${ports.web}' },
			envFile: '.env',
			scripts: { setup: 'printf "$PORT" > cache/port', teardown: 'exit 0' }
		});
		const { hash } = await engine.workspaceConfig({ projectId, base: 'trunk' });
		const w = await create('full', { trustConfigHash: hash });
		await until(() => w.provision.status !== 'running');
		expect(w.provision.status, w.provision.log).toBe('ready');
		const port = String(w.provision.ports.web);
		const env = fs.readFileSync(path.join(w.path, '.env'), 'utf8');
		expect(env).toContain('FROM_PRIMARY=1');
		expect(env).toContain(`PORT=${port}`);
		expect(env).toContain(`PUBLIC_URL=http://localhost:${port}`);
		expect(fs.readFileSync(path.join(w.path, 'cache', 'blob'), 'utf8')).toBe('cached');
		expect(fs.readFileSync(path.join(w.path, 'cache', 'port'), 'utf8')).toBe(port);
		expect(fs.readFileSync(path.join(repo, '.env'), 'utf8')).toContain('PORT=3000');

		const other = await create('second');
		await until(() => other.provision.status !== 'running');
		expect(other.provision.ports.web).not.toBe(w.provision.ports.web);

		fs.writeFileSync(path.join(w.path, 'dirty.txt'), 'x');
		await expect(engine.deleteWorkspace(w.id)).rejects.toThrow(/uncommitted/);
		fs.rmSync(path.join(w.path, 'dirty.txt'));
		expect(await engine.deleteWorkspace(w.id)).toEqual({ warnings: [] });
		expect(fs.existsSync(w.path)).toBe(false);
		expect(engine.store.state.workspaces.some((x: { id: string }) => x.id === w.id)).toBe(false);
		expect(git(repo, 'branch', '--list', 'feat/full')).toContain('feat/full');
	});

	it('uses the approved config for retries, not an edited checkout', async () => {
		commitConfig({ scripts: { setup: 'test -f go && touch approved' } });
		const { hash } = await engine.workspaceConfig({ projectId, base: 'trunk' });
		const w = await create('retry', { trustConfigHash: hash });
		await until(() => w.provision.status !== 'running');
		expect(w.provision.status).toBe('failed');

		fs.writeFileSync(
			path.join(w.path, '.workbench.json'),
			JSON.stringify({ scripts: { setup: 'touch tampered' } })
		);
		fs.writeFileSync(path.join(w.path, 'go'), '');
		engine.retryProvision(w.id);
		await until(() => w.provision.status !== 'running');
		expect(w.provision.status).toBe('ready');
		expect(fs.existsSync(path.join(w.path, 'approved'))).toBe(true);
		expect(fs.existsSync(path.join(w.path, 'tampered'))).toBe(false);
	});

	it('refuses to delete the main workspace', async () => {
		const main = engine.store.state.workspaces.find((w: { path: string }) => w.path === repo);
		await expect(engine.deleteWorkspace(main.id)).rejects.toThrow(/main workspace/);
	});

	it('opens an existing branch', async () => {
		git(repo, 'branch', 'already-here');
		const w = await engine.workspace({
			projectId,
			name: 'existing',
			branch: 'already-here',
			existingBranch: true
		});
		expect(git(w.path, 'branch', '--show-current')).toBe('already-here');
	});

	it('skips tracked and missing paths when applying config', async () => {
		const logs: string[] = [];
		const target = path.join(dir, 'target');
		fs.mkdirSync(target);
		await applyPaths(
			parseConfig(JSON.stringify({ copy: ['tracked.txt', 'missing'] })),
			repo,
			target,
			{ log: (t: string) => logs.push(t) }
		);
		expect(fs.readdirSync(target)).toEqual([]);
		expect(logs.join('')).toMatch(/tracked\.txt is not gitignored/);
		expect(logs.join('')).toMatch(/missing not in the primary/);
	});

	it('tells agents where worktrees live without naming a specific checkout', async () => {
		const w = await create('prompted');
		const chat = { title: 'T', members: [], messages: [], leadId: null };
		const member = {
			id: 'm',
			name: 'M',
			handle: 'm',
			role: '',
			provider: 'claude',
			mode: 'assess',
			sessionId: null,
			seen: 0
		};
		const prompt = engine.prompt(chat, member, { by: 'you' }, w, null);
		expect(prompt).toContain(`live under ${path.dirname(w.path)}`);
		expect(prompt).toContain(`primary checkout is ${repo}`);
		expect(prompt).toContain('git worktree list');
		expect(prompt).not.toContain(w.path);
	});
});
