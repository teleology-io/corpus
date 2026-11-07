import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine, Store } from '../../src/lib/server/wrx/core.js';
import {
	discoverCommands,
	packageManager,
	parseEnvLines,
	parseFlags,
	readLogTail,
	withFlags
} from '../../src/lib/server/wrx/runner.js';

let dir: string;
const write = (name: string, text: string) => fs.writeFileSync(path.join(dir, name), text);
const lines = (options?: { composeProject?: string }) =>
	discoverCommands(dir, options).map((t: { command: string; args: string[] }) =>
		[t.command, ...t.args].join(' ')
	);

beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-runner-')));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('discoverCommands', () => {
	it('finds nothing in an empty directory or a missing one', () => {
		expect(discoverCommands(dir)).toEqual([]);
		expect(discoverCommands(path.join(dir, 'missing'))).toEqual([]);
	});

	it('lists package.json scripts in order, with their contents', () => {
		write('package.json', JSON.stringify({ scripts: { test: 'vitest', dev: 'vite', '-x': 'no' } }));
		expect(lines()).toEqual(['npm run dev', 'npm run test']);
		expect(discoverCommands(dir)[0]).toMatchObject({ source: 'package.json', detail: 'vite' });
	});

	it('ignores package.json it cannot use', () => {
		for (const raw of ['not json', '{"scripts": []}', '{"scripts": {"a": 1}}', 'null']) {
			write('package.json', raw);
			expect(lines(), raw).toEqual([]);
		}
	});

	it('finds Make targets and skips what would need evaluating', () => {
		write(
			'Makefile',
			[
				'VERSION := 1',
				'NAME=a:b',
				'.PHONY: build',
				'build: deps',
				'\tgo build',
				'  indented: no',
				'# comment: no',
				'%.o: %.c',
				'$(TARGET): x',
				'a b: c',
				'test:',
				'build:'
			].join('\n')
		);
		expect(lines()).toEqual(['make -f Makefile build', 'make -f Makefile test']);
	});

	it('finds parameterless Just recipes and skips private and parameterized ones', () => {
		write(
			'justfile',
			[
				'set shell := ["sh"]',
				'alias b := build',
				'build:',
				'deploy env:',
				'_hidden:',
				'lint: build'
			].join('\n')
		);
		expect(lines()).toEqual(['just build', 'just lint']);
	});

	it('reads only [project.scripts] from pyproject.toml', () => {
		write(
			'pyproject.toml',
			[
				'[tool.other]',
				'nope = "a:b"',
				'[project.scripts]',
				'serve = "app.main:run" # entry',
				'bad = "not an entry"',
				'[project.urls]',
				'home = "a:b"'
			].join('\n')
		);
		expect(lines()).toEqual(['serve']);
	});

	it('adds test commands for Go and Rust', () => {
		write('go.mod', 'module x');
		write('Cargo.toml', '');
		expect(lines()).toEqual(['go test ./...', 'cargo test']);
	});

	it('adds Compose commands under the project name it is given', () => {
		write('docker-compose.yml', 'services: {}');
		expect(lines({ composeProject: 'wrx-abc' })).toEqual([
			'docker compose -p wrx-abc -f docker-compose.yml up',
			'docker compose -p wrx-abc -f docker-compose.yml down'
		]);
	});
});

describe('packageManager', () => {
	it('prefers the declared manager, then the lockfile, then npm', () => {
		expect(packageManager(dir)).toBe('npm');
		write('yarn.lock', '');
		expect(packageManager(dir)).toBe('yarn');
		write('pnpm-lock.yaml', '');
		expect(packageManager(dir)).toBe('pnpm');
		expect(packageManager(dir, 'bun@1.2.0')).toBe('bun');
		expect(packageManager(dir, 'rm -rf /@1')).toBe('pnpm');
	});
});

describe('parseFlags', () => {
	it('splits words and respects quotes and escapes', () => {
		expect(parseFlags('')).toEqual([]);
		expect(parseFlags('  -c   local ')).toEqual(['-c', 'local']);
		expect(parseFlags(`--name "a b" --x='c d' e\\ f ""`)).toEqual([
			'--name',
			'a b',
			'--x=c d',
			'e f',
			''
		]);
		expect(parseFlags('"say \\"hi\\""')).toEqual(['say "hi"']);
	});

	it('leaves shell syntax as literal text', () => {
		expect(parseFlags('$FOO && rm -rf *')).toEqual(['$FOO', '&&', 'rm', '-rf', '*']);
	});

	it('refuses an unclosed quote', () => {
		expect(() => parseFlags('"open')).toThrow(/unclosed/);
	});
});

describe('parseEnvLines', () => {
	it('accepts dotenv and shell lines', () => {
		expect(
			parseEnvLines('FOO=example\n\n# note\nexport BAR="a b"\nBAZ=\'c\'\nURL=x=y\nEMPTY=')
		).toEqual({ FOO: 'example', BAR: 'a b', BAZ: 'c', URL: 'x=y', EMPTY: '' });
	});

	it('names the bad line without repeating its text', () => {
		for (const bad of ['secret-value', '1A=x', 'A B=x']) {
			expect(() => parseEnvLines(`OK=1\n${bad}`), bad).toThrow('line 2');
			try {
				parseEnvLines(bad);
			} catch (error) {
				expect((error as Error).message).not.toContain(bad);
			}
		}
	});
});

describe('withFlags', () => {
	const task = (command: string) => ({ command, args: ['run', 'start'] });
	it('adds -- only for npm', () => {
		expect(withFlags(task('pnpm'), ['-c', 'local']).args).toEqual(['run', 'start', '-c', 'local']);
		expect(withFlags(task('npm'), ['-c', 'local']).args).toEqual([
			'run',
			'start',
			'--',
			'-c',
			'local'
		]);
		expect(withFlags(task('npm'), []).args).toEqual(['run', 'start']);
	});
});

describe('readLogTail', () => {
	it('returns a missing log as empty', () => {
		expect(readLogTail(path.join(dir, 'none.log'), 100)).toBe('');
	});

	it('removes terminal sequences and any partial first line', () => {
		write('a.log', 'first line\nsecond \u001b[32mgreen\u001b[0m\n');
		expect(readLogTail(path.join(dir, 'a.log'), 1000)).toBe('first line\nsecond green\n');
		expect(readLogTail(path.join(dir, 'a.log'), 25)).toBe('second green\n');
	});
});

describe('Engine commands', () => {
	type Child = EventEmitter & { pid: number; stdout: EventEmitter; stderr: EventEmitter };
	let engine: Engine;
	let spawned: {
		bin: string;
		args: string[];
		options: { cwd: string; env: object };
		child: Child;
	}[];
	let workspaceId: string;
	let kill: ReturnType<typeof vi.spyOn>;

	const makeEngine = () => {
		engine = new Engine(new Store(path.join(dir, 'state')), () => {}, ((
			bin: string,
			args: string[],
			options: { cwd: string; env: object }
		) => {
			const child = Object.assign(new EventEmitter(), {
				pid: 4242,
				stdout: new EventEmitter(),
				stderr: new EventEmitter()
			});
			spawned.push({ bin, args, options, child });
			return child;
		}) as never);
	};
	const flush = () => {
		if (engine.changeTimer) clearTimeout(engine.changeTimer);
		engine.changeTimer = null;
	};

	beforeEach(() => {
		spawned = [];
		kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
		const repo = path.join(dir, 'repo');
		fs.mkdirSync(repo);
		fs.writeFileSync(
			path.join(repo, 'package.json'),
			JSON.stringify({ scripts: { dev: 'vite', test: 'vitest' } })
		);
		makeEngine();
		workspaceId = 'a1b2c3d4-0000-0000-0000-000000000000';
		const { state } = engine.store;
		state.projects.push({ id: 'p', name: 'repo', path: repo });
		state.workspaces.push({
			id: workspaceId,
			projectId: 'p',
			name: 'w',
			branch: 'b',
			path: repo,
			environmentId: null,
			provision: { status: 'ready', env: { PORT: '20000' } }
		});
	});
	afterEach(() => {
		flush();
		kill.mockRestore();
	});

	it('starts a declared command in the worktree with the workspace env', () => {
		const run = engine.runStart(workspaceId, 'package.json:dev');
		expect(run).toMatchObject({ status: 'running', line: 'npm run dev', name: 'dev' });
		expect(spawned[0]).toMatchObject({ bin: 'npm', args: ['run', 'dev'] });
		expect(spawned[0].options.cwd).toBe(path.join(dir, 'repo'));
		expect(spawned[0].options.env).toMatchObject({ PORT: '20000' });
	});

	it('refuses anything the checkout does not declare', () => {
		expect(() => engine.runStart(workspaceId, 'package.json:rm -rf')).toThrow(/no longer/);
		expect(spawned).toEqual([]);
	});

	it('uses an attached VM as the Docker target', () => {
		const { state } = engine.store;
		state.environments.push({ id: 'e', profile: 'wrx-vm', busy: false });
		state.workspaces[0].environmentId = 'e';
		engine.runStart(workspaceId, 'package.json:dev');
		expect(spawned[0].options.env).toMatchObject({
			DOCKER_HOST: expect.stringContaining('wrx-vm')
		});
	});

	it('refuses a second copy of a running command, but not a different one', () => {
		engine.runStart(workspaceId, 'package.json:dev');
		expect(() => engine.runStart(workspaceId, 'package.json:dev')).toThrow(/already running/);
		engine.runStart(workspaceId, 'package.json:test');
		expect(spawned).toHaveLength(2);
	});

	it('waits for setup, database and environment operations', () => {
		const w = engine.store.state.workspaces[0];
		w.provision.status = 'running';
		expect(() => engine.runStart(workspaceId, 'package.json:dev')).toThrow(/setup/);
		w.provision.status = 'ready';
		w.database = { busy: true };
		expect(() => engine.runStart(workspaceId, 'package.json:dev')).toThrow(/database/);
		w.database.busy = false;
		engine.store.state.environments.push({ id: 'e', profile: 'x', busy: true });
		w.environmentId = 'e';
		expect(() => engine.runStart(workspaceId, 'package.json:dev')).toThrow(/environment/);
	});

	it('writes output to its log and records how the run ended', () => {
		const run = engine.runStart(workspaceId, 'package.json:test');
		spawned[0].child.stdout.emit('data', Buffer.from('out\n'));
		spawned[0].child.stderr.emit('data', Buffer.from('err\n'));
		expect(engine.runLog(run.id).log).toBe('$ npm run test\nout\nerr\n');
		spawned[0].child.emit('close', 1, null);
		expect(run).toMatchObject({ status: 'failed', exitCode: 1, error: 'Exited with code 1' });
		expect(JSON.stringify(engine.store.state)).not.toContain('out\\n');
	});

	it('reports a missing executable', () => {
		const run = engine.runStart(workspaceId, 'package.json:dev');
		spawned[0].child.emit('error', Object.assign(new Error('spawn'), { code: 'ENOENT' }));
		expect(run.status).toBe('failed');
		expect(run.error).toMatch(/isn't installed/);
		expect(() => engine.runStop(run.id)).toThrow(/not running/);
	});

	it('stops the whole process group and records it as stopped', () => {
		const run = engine.runStart(workspaceId, 'package.json:dev');
		engine.runStop(run.id);
		expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
		spawned[0].child.emit('close', null, 'SIGTERM');
		expect(run).toMatchObject({ status: 'stopped', error: null });
	});

	it('stops every running command when the server exits', () => {
		engine.runStart(workspaceId, 'package.json:dev');
		engine.runStart(workspaceId, 'package.json:test');
		kill.mockClear();
		engine.stopCommands();
		expect(kill).toHaveBeenCalledTimes(2);
	});

	it('blocks removing a workspace with a running command', () => {
		const w = engine.store.state.workspaces[0];
		const run = engine.runStart(workspaceId, 'package.json:dev');
		expect(() => engine.assertRemovable(w)).toThrow(/running commands/);
		spawned[0].child.emit('close', 0, null);
		expect(run.status).toBe('exited');
		expect(() => engine.assertRemovable(w)).not.toThrow();
	});

	it('removes runs and logs with their workspace', () => {
		const run = engine.runStart(workspaceId, 'package.json:dev');
		spawned[0].child.emit('close', 0, null);
		const log = engine.runLogFile(run.id);
		expect(fs.existsSync(log)).toBe(true);
		engine.forgetWorkspaces(new Set([workspaceId]));
		expect(engine.store.state.commandRuns).toEqual([]);
		expect(fs.existsSync(log)).toBe(false);
	});

	it('deletes a finished run and its log, but not a running one', () => {
		const run = engine.runStart(workspaceId, 'package.json:dev');
		expect(() => engine.runDelete(run.id)).toThrow(/Stop this command/);
		spawned[0].child.emit('close', 0, null);
		const log = engine.runLogFile(run.id);
		engine.runDelete(run.id);
		expect(engine.store.state.commandRuns).toEqual([]);
		expect(fs.existsSync(log)).toBe(false);
	});

	it('clears finished runs and leaves running ones and other workspaces alone', () => {
		const active = engine.runStart(workspaceId, 'package.json:dev');
		const done = engine.runStart(workspaceId, 'package.json:test');
		spawned[1].child.emit('close', 0, null);
		const other = { id: 'x', workspaceId: 'other', status: 'exited' };
		engine.store.state.commandRuns.push(other);
		engine.runClear(workspaceId);
		expect(engine.store.state.commandRuns).toEqual([active, other]);
		expect(fs.existsSync(engine.runLogFile(done.id))).toBe(false);
	});

	it('keeps a limited history and never prunes a running command', () => {
		const active = engine.runStart(workspaceId, 'package.json:dev');
		const first = engine.runStart(workspaceId, 'package.json:test');
		spawned[1].child.emit('close', 0, null);
		for (let i = 0; i < 25; i++) {
			engine.runStart(workspaceId, 'package.json:test');
			spawned.at(-1)?.child.emit('close', 0, null);
		}
		const { commandRuns } = engine.store.state;
		expect(commandRuns.filter((r: { status: string }) => r.status !== 'running').length).toBe(20);
		expect(commandRuns).toContain(active);
		expect(commandRuns).not.toContain(first);
		expect(fs.existsSync(engine.runLogFile(first.id))).toBe(false);
	});

	it('marks runs left running as interrupted on restart, without signalling them', () => {
		const run = engine.runStart(workspaceId, 'package.json:dev');
		flush();
		engine.store.save();
		kill.mockClear();
		makeEngine();
		const reloaded = engine.store.get('commandRuns', run.id);
		expect(reloaded.status).toBe('interrupted');
		expect(reloaded.finishedAt).toBeTruthy();
		expect(kill).not.toHaveBeenCalled();
	});

	it('loads state saved before commands existed', () => {
		const stateDir = path.join(dir, 'old');
		fs.mkdirSync(stateDir);
		fs.writeFileSync(
			path.join(stateDir, 'state.json'),
			JSON.stringify({ projects: [], workspaces: [], environments: [], chats: [], tasks: [] })
		);
		expect(new Store(stateDir).state.commandRuns).toEqual([]);
	});

	describe('variants', () => {
		const save = (fields: object = {}) =>
			engine.runVariantSave({
				workspaceId,
				taskId: 'package.json:dev',
				name: 'local',
				flags: '-c local',
				env: 'export FOO=example',
				...fields
			});

		it('runs with its flags and env, recording env names but not values', () => {
			const variant = save();
			const run = engine.runStart(workspaceId, 'package.json:dev', variant.id);
			expect(spawned[0].args).toEqual(['run', 'dev', '--', '-c', 'local']);
			expect(spawned[0].options.env).toMatchObject({ FOO: 'example', PORT: '20000' });
			expect(run).toMatchObject({
				taskId: `package.json:dev#${variant.id}`,
				name: 'dev · local',
				line: 'npm run dev -- -c local',
				envNames: ['FOO']
			});
			expect(JSON.stringify(run)).not.toContain('example');
			expect(engine.runLog(run.id).log).toBe('$ npm run dev -- -c local\nEnv values set: FOO\n');
		});

		it('overrides workspace env values', () => {
			const variant = save({ env: 'PORT=9999' });
			engine.runStart(workspaceId, 'package.json:dev', variant.id);
			expect(spawned[0].options.env).toMatchObject({ PORT: '9999' });
		});

		it('runs alongside the plain command, but not twice', () => {
			const variant = save();
			engine.runStart(workspaceId, 'package.json:dev');
			engine.runStart(workspaceId, 'package.json:dev', variant.id);
			expect(spawned).toHaveLength(2);
			expect(() => engine.runStart(workspaceId, 'package.json:dev', variant.id)).toThrow(
				/"dev · local" is already running/
			);
		});

		it("leaves the plain command's flags and env alone", () => {
			save();
			engine.runStart(workspaceId, 'package.json:dev');
			expect(spawned[0].args).toEqual(['run', 'dev']);
			expect(spawned[0].options.env).not.toHaveProperty('FOO');
		});

		it('refuses a variant of another command or one that is gone', () => {
			const variant = save();
			expect(() => engine.runStart(workspaceId, 'package.json:test', variant.id)).toThrow(
				/no longer exists/
			);
			engine.runVariantDelete(workspaceId, variant.id);
			expect(() => engine.runStart(workspaceId, 'package.json:dev', variant.id)).toThrow(
				/no longer exists/
			);
			expect(spawned).toEqual([]);
		});

		it('validates what it saves', () => {
			expect(() => save({ name: ' ' })).toThrow(/name/);
			expect(() => save({ flags: '"open' })).toThrow(/unclosed/);
			expect(() => save({ env: 'not env' })).toThrow(/NAME=value/);
			expect(() => save({ taskId: 'package.json:nope' })).toThrow(/no longer/);
			save();
			expect(() => save()).toThrow(/already has a variant/);
		});

		it('edits in place, keeping its identity and history', () => {
			const variant = save();
			const edited = save({ variantId: variant.id, flags: '-c prod', env: '' });
			expect(edited.id).toBe(variant.id);
			expect(engine.store.get('projects', 'p').runVariants).toHaveLength(1);
			expect(engine.runTasks(workspaceId)[0].variants[0]).toMatchObject({
				key: `package.json:dev#${variant.id}`,
				line: 'npm run dev -- -c prod',
				env: {}
			});
		});

		it('is shared by every workspace in the project and not by others', () => {
			save();
			const { state } = engine.store;
			const repo = state.workspaces[0].path;
			state.workspaces.push({ ...state.workspaces[0], id: 'second' });
			state.projects.push({ id: 'q', name: 'other', path: repo });
			state.workspaces.push({ ...state.workspaces[0], id: 'third', projectId: 'q' });
			expect(engine.runTasks('second')[0].variants).toHaveLength(1);
			expect(engine.runTasks('third')[0].variants).toEqual([]);
		});
	});

	it('tells a new agent which commands the checkout has', () => {
		const w = engine.store.state.workspaces[0];
		expect(engine.commandsContext(w)).toBe(
			'Project commands found in this checkout: npm run dev, npm run test.\n'
		);
		w.path = path.join(dir, 'missing');
		expect(engine.commandsContext(w)).toBe('');
	});
});
