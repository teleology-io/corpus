import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine, Store } from '../../src/lib/server/wrx/core.js';
import { discoverCommands, packageManager } from '../../src/lib/server/wrx/discover.js';
import {
	parseCommand,
	parseEnvLines,
	parseFlags,
	parseFolder,
	readLogTail,
	withFlags,
	withVirtualenv
} from '../../src/lib/server/wrx/runner.js';

let dir: string;
const write = (name: string, text: string) => {
	fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
	fs.writeFileSync(path.join(dir, name), text);
};
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
		expect(lines()).toEqual([
			'make -f Makefile build',
			'make -f Makefile a',
			'make -f Makefile b',
			'make -f Makefile test'
		]);
	});

	it('does not mistake Make variables, conditionals or define bodies for targets', () => {
		write(
			'Makefile',
			[
				'FOO::=x',
				'FOO ::= x',
				'BAR = a:b',
				'BAZ ?= a:b',
				'ifeq (a,b:c)',
				'include x:y',
				'-include x:y',
				'define BODY',
				'inner: no',
				'endef',
				'lint:: deps'
			].join('\n')
		);
		expect(lines()).toEqual(['make -f Makefile lint']);
	});

	it('reads Just recipe forms that run without arguments', () => {
		write(
			'.justfile',
			[
				'version := "1"',
				'@quiet:',
				'[private]',
				'hidden:',
				'[group("x")]',
				'# a comment between',
				'grouped:',
				'[doc("a: b")]',
				'[private, no-cd]',
				'hidden2:',
				'deploy env="a:b" *rest: quiet',
				'plus +rest:',
				'mixed a b="x":',
				'with-env $FOO="y":'
			].join('\n')
		);
		expect(lines()).toEqual(['just quiet', 'just grouped', 'just deploy', 'just with-env']);
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

	it('adds test, build and lint commands for Go and Rust', () => {
		write('go.mod', 'module x');
		write('Cargo.toml', '');
		expect(lines()).toEqual([
			'go test ./...',
			'go build ./...',
			'go vet ./...',
			'cargo test',
			'cargo build',
			'cargo clippy',
			'cargo fmt --check'
		]);
	});

	it('runs Go main packages at the root and under cmd', () => {
		write('go.mod', 'module x');
		write('main.go', '// doc\npackage main\n');
		write('cmd/api/main.go', 'package main\n');
		write('cmd/lib/lib.go', 'package lib\n');
		write('cmd/only-test/x_test.go', 'package main\n');
		expect(lines().slice(0, 2)).toEqual(['go run .', 'go run ./cmd/api']);
	});

	it('runs Rust binaries, naming them when cargo would refuse to guess', () => {
		write('Cargo.toml', '[package]\nname = "app"\n');
		expect(lines()).not.toContain('cargo run');
		write('src/main.rs', '');
		expect(lines()[0]).toBe('cargo run');
		write('src/bin/tool.rs', '');
		expect(lines().slice(0, 2)).toEqual(['cargo run --bin app', 'cargo run --bin tool']);
		write('Cargo.toml', '[package]\nname = "app"\ndefault-run = "app"\n');
		expect(lines()[0]).toBe('cargo run');
		expect(lines()).toContain('cargo run --bin tool');
	});

	it('offers no cargo run for a virtual workspace', () => {
		write('Cargo.toml', '[workspace]\nmembers = ["a"]\n');
		write('src/main.rs', '');
		expect(lines()).not.toContain('cargo run');
	});

	it('reads Poetry, PDM and Hatch scripts', () => {
		write(
			'pyproject.toml',
			[
				'[tool.poetry.scripts]',
				'serve = "a.b:c"',
				'[tool.pdm.scripts]',
				'_ = { env_file = ".env" }',
				'lint = "ruff"',
				'[tool.pdm.scripts.fmt]',
				'cmd = "x"',
				'[tool.hatch.envs.default.scripts]',
				'cov = "x"',
				'[tool.hatch.envs.docs.scripts]',
				'build = "x"'
			].join('\n')
		);
		expect(lines()).toEqual(
			expect.arrayContaining([
				'poetry run serve',
				'pdm run lint',
				'pdm run fmt',
				'hatch run cov',
				'hatch run docs:build'
			])
		);
		expect(lines().join()).not.toContain('run _');
	});

	it('runs Python tools through the project runner', () => {
		write('pyproject.toml', '[project.scripts]\nserve = "a.b:c"\n[tool.ruff]\nline-length = 1\n');
		write('requirements-dev.txt', 'pytest==8\n');
		write('uv.lock', '');
		expect(lines()).toEqual([
			'uv run serve',
			'uv run pytest',
			'uv run ruff check .',
			'uv run ruff format --check .'
		]);
	});

	it('finds Django, and only Django, from manage.py', () => {
		write('manage.py', 'print("not it")');
		expect(lines()).toEqual([]);
		write('manage.py', 'os.environ.setdefault("DJANGO_SETTINGS_MODULE", "a")');
		expect(lines()[0]).toBe('python3 manage.py runserver');
		write('.venv/pyvenv.cfg', '');
		expect(lines()[0]).toBe('python manage.py runserver');
	});

	it('uses the Gradle and Maven wrappers when a checkout has them', () => {
		write('build.gradle.kts', 'plugins {\n  application\n  id("org.springframework.boot")\n}');
		expect(lines()).toEqual(['gradle bootRun', 'gradle run', 'gradle test', 'gradle build']);
		write('gradlew', '');
		expect(lines()[0]).toBe('./gradlew bootRun');
		fs.rmSync(path.join(dir, 'build.gradle.kts'));
		fs.rmSync(path.join(dir, 'gradlew'));
		write('pom.xml', '<artifactId>spring-boot-starter</artifactId>');
		write('mvnw', '');
		expect(lines()).toEqual(['./mvnw spring-boot:run', './mvnw test', './mvnw package']);
	});

	it('reads Composer scripts without their event hooks, and Laravel commands', () => {
		write(
			'composer.json',
			JSON.stringify({
				scripts: { test: ['a', 'b'], 'post-install-cmd': 'x', 'lint:fix': 'y' }
			})
		);
		write('artisan', '');
		write('phpunit.xml', '');
		expect(lines()).toEqual([
			'composer run-script lint:fix',
			'composer run-script test',
			'php artisan serve',
			'php artisan test',
			'php artisan migrate'
		]);
		expect(discoverCommands(dir)[1].detail).toBe('a && b');
	});

	it('reads Rake tasks, Rails and bundled tools', () => {
		write(
			'Rakefile',
			[
				'task :build do',
				'task test: :build',
				'task "release"',
				'RSpec::Core::RakeTask.new(:spec)',
				'namespace :db do',
				'  task :nested',
				'end'
			].join('\n')
		);
		expect(lines()).toEqual(['rake build', 'rake release', 'rake spec', 'rake test']);
		write('Gemfile', 'gem "rspec"\ngem "rubocop"');
		write('spec/a_spec.rb', '');
		write('bin/rails', '');
		expect(lines()).toEqual([
			'./bin/rails server',
			'./bin/rails test',
			'./bin/rails db:migrate',
			'bundle exec rake build',
			'bundle exec rake release',
			'bundle exec rake spec',
			'bundle exec rake test',
			'bundle exec rspec',
			'bundle exec rubocop'
		]);
	});

	it('finds mix commands, with Phoenix when it is a dependency', () => {
		write('mix.exs', '{:phoenix, "~> 1.7"}');
		expect(lines()).toEqual([
			'mix phx.server',
			'mix test',
			'mix compile',
			'mix format --check-formatted'
		]);
	});

	it('names the dotnet target only when the folder holds several', () => {
		write('App.csproj', '<OutputType>Exe</OutputType>');
		expect(lines()).toEqual(['dotnet run --project App.csproj', 'dotnet test', 'dotnet build']);
		write('App.sln', '');
		expect(lines()).toEqual([
			'dotnet run --project App.csproj',
			'dotnet test App.sln',
			'dotnet build App.sln'
		]);
		write('App.csproj', '<Project Sdk="Microsoft.NET.Sdk"></Project>');
		expect(lines()).toEqual(['dotnet test App.sln', 'dotnet build App.sln']);
	});

	it('reads Deno tasks from JSON with comments', () => {
		write(
			'deno.jsonc',
			'{\n// "x": "http://no"\n"tasks": { /* c */ "dev": "deno run http://a.b/c", "b": { "command": "x" }, },\n}'
		);
		expect(lines()).toEqual(['deno task b', 'deno task dev', 'deno test']);
		expect(discoverCommands(dir)[1].detail).toBe('deno run http://a.b/c');
	});

	it('reads Taskfile tasks and skips internal and templated ones', () => {
		write(
			'Taskfile.yml',
			[
				'version: "3"',
				'vars:',
				'  NOPE: no',
				'tasks:',
				'  build:',
				'    cmds:',
				'      - go build',
				'  hidden:',
				'    internal: true',
				'  "db:migrate":',
				'    cmds: [x]',
				'  short: go test',
				'  "{{.NAME}}":',
				'    cmds: [x]',
				'includes:',
				'  other: x'
			].join('\n')
		);
		expect(lines()).toEqual(['task build', 'task db:migrate', 'task short']);
	});

	describe('workspaces', () => {
		const scripts = (name: string) =>
			write(`${name}/package.json`, JSON.stringify({ scripts: { dev: 'x' } }));

		it('lists package scripts with the root package manager, to run in their folder', () => {
			write('package.json', JSON.stringify({ scripts: { all: 'x' }, workspaces: ['apps/*'] }));
			write('yarn.lock', '');
			scripts('apps/web');
			scripts('other/no');
			expect(lines()).toEqual(['yarn run all', 'yarn run dev']);
			expect(discoverCommands(dir)[1]).toMatchObject({
				id: 'apps/web/package.json:dev',
				source: 'apps/web/package.json',
				cwd: 'apps/web',
				command: 'yarn'
			});
		});

		it('reads the object form of workspaces', () => {
			write('package.json', JSON.stringify({ workspaces: { packages: ['libs/**'] } }));
			scripts('libs/a/b');
			expect(discoverCommands(dir).map((t: { cwd: string }) => t.cwd)).toEqual(['libs/a/b']);
		});

		it('reads pnpm-workspace.yaml, with exclusions, and needs no root package.json', () => {
			write(
				'pnpm-workspace.yaml',
				[
					'packages:',
					"  - 'apps/*'",
					'  - packages/** # all',
					'  - "!packages/skip"',
					'catalog:',
					'  - nope/*'
				].join('\n')
			);
			for (const name of ['apps/a', 'packages/b/c', 'packages/skip', 'nope/d']) scripts(name);
			const found = discoverCommands(dir);
			expect(found.map((t: { cwd: string }) => t.cwd)).toEqual(['apps/a', 'packages/b/c']);
			expect(found[0].command).toBe('pnpm');
		});

		it('does not follow links or leave the checkout', () => {
			const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-outside-'));
			try {
				fs.writeFileSync(path.join(outside, 'package.json'), '{"scripts":{"x":"y"}}');
				write('package.json', JSON.stringify({ workspaces: ['apps/*', '../*', outside] }));
				fs.mkdirSync(path.join(dir, 'apps'));
				fs.symlinkSync(outside, path.join(dir, 'apps', 'link'));
				expect(discoverCommands(dir)).toEqual([]);
			} finally {
				fs.rmSync(outside, { recursive: true, force: true });
			}
		});

		it('skips node_modules', () => {
			write('package.json', JSON.stringify({ workspaces: ['**'] }));
			scripts('node_modules/dep');
			scripts('apps/a');
			expect(discoverCommands(dir).map((t: { cwd: string }) => t.cwd)).toEqual(['apps/a']);
		});

		it('reads go.work modules in both forms', () => {
			write('go.work', 'go 1.22\nuse ./one\nuse (\n\t./two // two\n\t../away\n)\n');
			write('one/go.mod', 'module one');
			write('two/go.mod', 'module two');
			write('two/main.go', 'package main');
			const found = discoverCommands(dir);
			expect(found.map((t: { cwd: string }) => t.cwd)).toEqual(
				expect.arrayContaining(['one', 'two'])
			);
			expect(found.find((t: { args: string[] }) => t.args[0] === 'run')).toMatchObject({
				id: 'two/go.mod:Run',
				cwd: 'two'
			});
		});
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

describe('parseCommand', () => {
	it('splits a command into an executable and arguments', () => {
		expect(parseCommand('bin/dev --port "3 0"')).toEqual({
			command: 'bin/dev',
			args: ['--port', '3 0']
		});
		expect(parseCommand(`sh -c "a && b"`).args).toEqual(['-c', 'a && b']);
	});

	it('refuses what would only work in a shell', () => {
		expect(() => parseCommand('  ')).toThrow(/Enter a command/);
		expect(() => parseCommand('FOO=1 npm test')).toThrow(/variant/);
		expect(() => parseCommand('make a && make b')).toThrow(/sh -c/);
		expect(() => parseCommand('ls | wc')).toThrow(/sh -c/);
	});
});

describe('parseFolder', () => {
	it('cleans a relative folder', () => {
		expect(parseFolder('')).toBe('');
		expect(parseFolder(' . ')).toBe('');
		expect(parseFolder('./a//b/')).toBe('a/b');
		expect(parseFolder('a\\b')).toBe('a/b');
	});

	it('refuses anything outside the checkout', () => {
		for (const bad of ['/etc', '..', '../a', 'a/../..', 'C:\\x'])
			expect(() => parseFolder(bad), bad).toThrow(/inside this checkout/);
	});
});

describe('withVirtualenv', () => {
	const bin = (folder: string) => path.join(dir, folder, 'bin');

	it('leaves the env alone without one', () => {
		const env = { PATH: '/usr/bin' };
		expect(withVirtualenv(env, dir)).toBe(env);
	});

	it('activates the first one found, and needs a real virtualenv', () => {
		fs.mkdirSync(bin('venv'), { recursive: true });
		expect(withVirtualenv({ PATH: '/usr/bin' }, dir)).toEqual({ PATH: '/usr/bin' });
		write('venv/pyvenv.cfg', '');
		expect(withVirtualenv({ PATH: '/usr/bin' }, path.join(dir, 'missing'), dir)).toEqual({
			PATH: `${bin('venv')}${path.delimiter}/usr/bin`,
			VIRTUAL_ENV: path.join(dir, 'venv')
		});
		write('.venv/pyvenv.cfg', '');
		expect(withVirtualenv({}, dir)).toEqual({
			PATH: bin('.venv'),
			VIRTUAL_ENV: path.join(dir, '.venv')
		});
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

	describe('custom commands', () => {
		const save = (fields: object = {}) =>
			engine.runCommandSave({ workspaceId, name: 'Serve', line: 'bin/dev --port 3000', ...fields });

		it('runs as saved, with no shell, and lists under Custom', () => {
			const saved = save();
			const task = engine
				.runTasks(workspaceId)
				.find((t: { custom?: string }) => t.custom === saved.id);
			expect(task).toMatchObject({ source: 'Custom', line: 'bin/dev --port 3000' });
			const run = engine.runStart(workspaceId, task.id);
			expect(spawned[0]).toMatchObject({ bin: 'bin/dev', args: ['--port', '3000'] });
			expect(run).toMatchObject({ name: 'Serve', source: 'Custom' });
		});

		it('runs in its folder, and says so when a checkout lacks it', () => {
			const saved = save({ cwd: './services/api/' });
			expect(saved.cwd).toBe('services/api');
			const key = `custom:${saved.id}`;
			expect(() => engine.runStart(workspaceId, key)).toThrow(/no folder named services\/api/);
			expect(spawned).toEqual([]);
			fs.mkdirSync(path.join(dir, 'repo', 'services', 'api'), { recursive: true });
			const run = engine.runStart(workspaceId, key);
			expect(spawned[0].options.cwd).toBe(path.join(dir, 'repo', 'services', 'api'));
			expect(run.line).toBe('cd services/api && bin/dev --port 3000');
		});

		it('takes variants, and removes them with the command', () => {
			const saved = save();
			const key = `custom:${saved.id}`;
			const variant = engine.runVariantSave({ workspaceId, taskId: key, name: 'x', flags: '-v' });
			engine.runStart(workspaceId, key, variant.id);
			expect(spawned[0].args).toEqual(['--port', '3000', '-v']);
			engine.runCommandDelete(workspaceId, saved.id);
			expect(engine.store.get('projects', 'p').runVariants).toEqual([]);
			expect(() => engine.runStart(workspaceId, key)).toThrow(/no longer/);
		});

		it('validates what it saves and edits in place', () => {
			expect(() => save({ name: ' ' })).toThrow(/name/);
			expect(() => save({ line: ' ' })).toThrow(/Enter a command/);
			expect(() => save({ line: 'a && b' })).toThrow(/sh -c/);
			expect(() => save({ cwd: '../up' })).toThrow(/inside this checkout/);
			const saved = save();
			expect(() => save()).toThrow(/already a custom command/);
			expect(() => save({ commandId: 'gone', name: 'Other' })).toThrow(/no longer exists/);
			const edited = save({ commandId: saved.id, line: 'bin/other' });
			expect(edited.id).toBe(saved.id);
			expect(engine.store.get('projects', 'p').runCommands).toHaveLength(1);
		});

		it('is shared by every workspace in the project and not by others', () => {
			save();
			const { state } = engine.store;
			state.workspaces.push({ ...state.workspaces[0], id: 'second' });
			state.projects.push({ id: 'q', name: 'other', path: state.workspaces[0].path });
			state.workspaces.push({ ...state.workspaces[0], id: 'third', projectId: 'q' });
			const custom = (id: string) =>
				engine.runTasks(id).filter((t: { source: string }) => t.source === 'Custom');
			expect(custom('second')).toHaveLength(1);
			expect(custom('third')).toEqual([]);
		});

		it('does not mark the workspace as using host Compose', () => {
			const saved = save({ name: 'ps', line: 'docker ps' });
			engine.runStart(workspaceId, `custom:${saved.id}`);
			expect(engine.store.state.workspaces[0].composeOnHost).toBeUndefined();
		});
	});

	it('runs a workspace package in its own folder', () => {
		const repo = path.join(dir, 'repo');
		const packageJson = path.join(repo, 'package.json');
		fs.writeFileSync(packageJson, JSON.stringify({ workspaces: ['apps/*'] }));
		fs.mkdirSync(path.join(repo, 'apps', 'web'), { recursive: true });
		fs.writeFileSync(
			path.join(repo, 'apps', 'web', 'package.json'),
			JSON.stringify({ scripts: { dev: 'vite' } })
		);
		const run = engine.runStart(workspaceId, 'apps/web/package.json:dev');
		expect(spawned[0].options.cwd).toBe(path.join(repo, 'apps', 'web'));
		expect(run.line).toBe('cd apps/web && npm run dev');
	});

	it('activates the checkout virtualenv, which a variant can override', () => {
		const repo = path.join(dir, 'repo');
		fs.mkdirSync(path.join(repo, '.venv'));
		fs.writeFileSync(path.join(repo, '.venv', 'pyvenv.cfg'), '');
		const variant = engine.runVariantSave({
			workspaceId,
			taskId: 'package.json:test',
			name: 'x',
			env: 'VIRTUAL_ENV=/other'
		});
		engine.runStart(workspaceId, 'package.json:dev');
		engine.runStart(workspaceId, 'package.json:test', variant.id);
		const env = (i: number) => spawned[i].options.env as { PATH: string; VIRTUAL_ENV: string };
		expect(env(0).VIRTUAL_ENV).toBe(path.join(repo, '.venv'));
		expect(env(0).PATH.split(path.delimiter)[0]).toBe(path.join(repo, '.venv', 'bin'));
		expect(env(1).VIRTUAL_ENV).toBe('/other');
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
