/* eslint-disable @typescript-eslint/ban-ts-comment -- plain JS, like the rest of wrx */
// @ts-nocheck — plain JS, like the rest of wrx.
// Finds the commands a checkout declares, for the Run tab. Only reads known files: nothing here runs
// repository code, and a command is an executable and argument array, never a shell string. Dynamic or
// parameterized declarations are skipped rather than evaluated.
import fs from 'node:fs';
import path from 'node:path';

const READ_LIMIT = 1 << 20;
const TASK_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const SCRIPT_NAME = /^[A-Za-z_][A-Za-z0-9_:.-]*$/;
const LOCKFILES = [
	['pnpm-lock.yaml', 'pnpm'],
	['yarn.lock', 'yarn'],
	['bun.lock', 'bun'],
	['bun.lockb', 'bun'],
	['package-lock.json', 'npm']
];
const PACKAGE_MANAGERS = new Set(LOCKFILES.map(([, manager]) => manager));
// The same names, in the same order, as Compose actions on the Environment tab.
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];
const VIRTUALENVS = ['.venv', 'venv'];
const MAKE_DIRECTIVES = new Set([
	'ifeq',
	'ifneq',
	'ifdef',
	'ifndef',
	'else',
	'endif',
	'include',
	'sinclude',
	'endef',
	'export',
	'unexport',
	'undefine',
	'override',
	'private',
	'vpath'
]);
// Workspace scanning is bounded, because it runs each time the list of commands is read.
const WORKSPACE_MAX_DEPTH = 5;
const WORKSPACE_MAX_VISITS = 5000;
const WORKSPACE_MAX_FOLDERS = 100;
const WORKSPACE_SKIPPED = new Set(['node_modules', 'vendor', 'target']);

function isFile(file) {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

function isDirectory(file) {
	try {
		return fs.statSync(file).isDirectory();
	} catch {
		return false;
	}
}

function readLimited(file) {
	let fd;
	try {
		fd = fs.openSync(file, 'r');
		const stat = fs.fstatSync(fd);
		if (!stat.isFile()) return null;
		const buffer = Buffer.alloc(Math.min(stat.size, READ_LIMIT));
		return buffer.toString('utf8', 0, fs.readSync(fd, buffer, 0, buffer.length, 0));
	} catch {
		return null;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function listDirectory(directory) {
	try {
		return fs.readdirSync(directory, { withFileTypes: true });
	} catch {
		return [];
	}
}

function readJson(file, prepare = (raw) => raw) {
	const raw = readLimited(file);
	if (raw === null) return null;
	try {
		return JSON.parse(prepare(raw));
	} catch {
		return null;
	}
}

function firstFile(directory, names) {
	return names.find((name) => isFile(path.join(directory, name)));
}

function task(source, name, command, args = [], detail = '') {
	return { id: `${source}:${name}`, name, source, command, args, detail };
}

// Tasks found in a subfolder: they run there, and are listed and identified by their full path.
function inFolder(folder, tasks) {
	return tasks.map((t) => ({
		...t,
		id: `${folder}/${t.id}`,
		source: `${folder}/${t.source}`,
		cwd: folder
	}));
}

// Single-line keys only, which is what every table read here uses.
function parseToml(raw) {
	const sections = new Set();
	const entries = [];
	let section = '';
	for (const line of raw.split(/\r?\n/).map((l) => l.trim())) {
		const header = line.match(/^\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/);
		if (header) {
			section = header[1];
			sections.add(section);
			continue;
		}
		const entry = line.match(/^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*=\s*(.*)$/);
		if (entry) entries.push({ section, key: entry[1] ?? entry[2] ?? entry[3], value: entry[4] });
	}
	return { sections, entries };
}

const tomlString = (value) => value.match(/^["']([^"']*)["']/)?.[1] ?? null;

function stripJsonComments(raw) {
	let out = '';
	let inString = false;
	for (let i = 0; i < raw.length; i++) {
		const c = raw[i];
		if (inString) {
			out += c;
			if (c === '\\') out += raw[++i] ?? '';
			else if (c === '"') inString = false;
		} else if (c === '/' && raw[i + 1] === '/') {
			while (i < raw.length && raw[i] !== '\n') i++;
			out += '\n';
		} else if (c === '/' && raw[i + 1] === '*') {
			const end = raw.indexOf('*/', i + 2);
			i = end < 0 ? raw.length : end + 1;
		} else {
			if (c === '"') inString = true;
			out += c;
		}
	}
	return out.replace(/,(\s*[}\]])/g, '$1');
}

function globRegex(pattern) {
	const source = pattern
		.replace(/^\.\//, '')
		.replace(/\/+$/, '')
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*\*\/|\*\*|\*/g, (m) => (m === '*' ? '[^/]*' : m === '**' ? '.*' : '(?:.*/)?'));
	return new RegExp(`^${source}$`);
}

// Folders matching workspace patterns. It walks down from the root and doesn't follow symbolic links,
// so a pattern can't reach outside the checkout.
function workspaceFolders(root, patterns) {
	const includes = patterns.filter((p) => !p.startsWith('!')).map(globRegex);
	const excludes = patterns.filter((p) => p.startsWith('!')).map((p) => globRegex(p.slice(1)));
	if (!includes.length) return [];
	const found = [];
	const queue = [''];
	for (
		let next = 0, visits = 0;
		next < queue.length && visits < WORKSPACE_MAX_VISITS && found.length < WORKSPACE_MAX_FOLDERS;
		next++, visits++
	) {
		const folder = queue[next];
		for (const entry of listDirectory(path.join(root, folder))) {
			if (!entry.isDirectory() || entry.name.startsWith('.') || WORKSPACE_SKIPPED.has(entry.name))
				continue;
			const child = folder ? `${folder}/${entry.name}` : entry.name;
			if (child.split('/').length < WORKSPACE_MAX_DEPTH) queue.push(child);
			if (includes.some((r) => r.test(child)) && !excludes.some((r) => r.test(child)))
				found.push(child);
		}
	}
	return found.slice(0, WORKSPACE_MAX_FOLDERS).sort();
}

export function packageManager(directory, declared) {
	const named = typeof declared === 'string' ? declared.split('@')[0] : '';
	if (PACKAGE_MANAGERS.has(named)) return named;
	const locked = LOCKFILES.find(([file]) => isFile(path.join(directory, file)))?.[1];
	if (locked) return locked;
	return isFile(path.join(directory, 'pnpm-workspace.yaml')) ? 'pnpm' : 'npm';
}

function scriptTasks(parsed, manager) {
	const scripts = parsed?.scripts;
	if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return [];
	return Object.keys(scripts)
		.filter((name) => name && !name.startsWith('-') && typeof scripts[name] === 'string')
		.sort()
		.map((name) => task('package.json', name, manager, ['run', name], scripts[name]));
}

function pnpmWorkspacePatterns(directory) {
	const raw = readLimited(path.join(directory, 'pnpm-workspace.yaml'));
	if (raw === null) return [];
	const patterns = [];
	let inPackages = false;
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim() || line.trim().startsWith('#')) continue;
		const item = line.match(/^\s*-\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/);
		if (line[0] !== ' ' && line[0] !== '\t' && !item)
			inPackages = /^packages:\s*(#.*)?$/.test(line);
		else if (inPackages && item) patterns.push(item[1] ?? item[2] ?? item[3]);
	}
	return patterns;
}

function jsWorkspacePatterns(directory, parsed) {
	const declared = parsed?.workspaces;
	const listed = Array.isArray(declared) ? declared : declared?.packages;
	return [
		...(Array.isArray(listed) ? listed.filter((p) => typeof p === 'string') : []),
		...pnpmWorkspacePatterns(directory)
	];
}

function javascriptTasks(directory) {
	const parsed = readJson(path.join(directory, 'package.json'));
	const manager = packageManager(directory, parsed?.packageManager);
	const packages = workspaceFolders(directory, jsWorkspacePatterns(directory, parsed)).flatMap(
		(folder) =>
			inFolder(folder, scriptTasks(readJson(path.join(directory, folder, 'package.json')), manager))
	);
	return [...scriptTasks(parsed, manager), ...packages];
}

function isGoMain(directory) {
	return listDirectory(directory).some(
		(entry) =>
			entry.isFile() &&
			entry.name.endsWith('.go') &&
			!entry.name.endsWith('_test.go') &&
			/^package\s+main\b/m.test(readLimited(path.join(directory, entry.name)) ?? '')
	);
}

function goModuleTasks(directory) {
	if (!isFile(path.join(directory, 'go.mod'))) return [];
	const commands = listDirectory(path.join(directory, 'cmd'))
		.filter((entry) => entry.isDirectory() && isGoMain(path.join(directory, 'cmd', entry.name)))
		.map((entry) => entry.name)
		.sort();
	return [
		...(isGoMain(directory) ? [task('go.mod', 'Run', 'go', ['run', '.'])] : []),
		...commands.map((name) => task('go.mod', `Run ${name}`, 'go', ['run', `./cmd/${name}`])),
		task('go.mod', 'Test Go packages', 'go', ['test', './...']),
		task('go.mod', 'Build Go packages', 'go', ['build', './...']),
		task('go.mod', 'Vet Go packages', 'go', ['vet', './...'])
	];
}

function goWorkPatterns(directory) {
	const raw = readLimited(path.join(directory, 'go.work'));
	if (raw === null) return [];
	const patterns = [];
	let inBlock = false;
	for (const original of raw.split(/\r?\n/)) {
		const line = original.replace(/\/\/.*$/, '').trim();
		const opened = line.match(/^use\s*\(\s*$/);
		const single = line.match(/^use\s+(\S+)$/);
		if (opened) inBlock = true;
		else if (inBlock && line === ')') inBlock = false;
		else if (single) patterns.push(single[1]);
		else if (inBlock && line) patterns.push(line);
	}
	return patterns
		.map((p) => p.replace(/^["'`]|["'`]$/g, ''))
		.filter((p) => !p.includes('*') && p !== '.' && p !== './');
}

function goTasks(directory) {
	return [
		...goModuleTasks(directory),
		...workspaceFolders(directory, goWorkPatterns(directory)).flatMap((folder) =>
			inFolder(folder, goModuleTasks(path.join(directory, folder)))
		)
	];
}

function rustBinaries(directory, sections, entries) {
	if (!sections.has('package')) return { names: [], defaultRun: false };
	const names = new Set();
	const packageKey = (key) =>
		tomlString(entries.find((e) => e.section === 'package' && e.key === key)?.value ?? '');
	const packageName = packageKey('name');
	if (packageName && isFile(path.join(directory, 'src/main.rs'))) names.add(packageName);
	for (const e of entries) {
		if (e.section === 'bin' && e.key === 'name' && tomlString(e.value))
			names.add(tomlString(e.value));
	}
	for (const entry of listDirectory(path.join(directory, 'src/bin'))) {
		if (entry.isFile() && entry.name.endsWith('.rs')) names.add(entry.name.slice(0, -3));
		else if (entry.isDirectory() && isFile(path.join(directory, 'src/bin', entry.name, 'main.rs')))
			names.add(entry.name);
	}
	return { names: [...names].sort(), defaultRun: Boolean(packageKey('default-run')) };
}

function rustTasks(directory) {
	const raw = readLimited(path.join(directory, 'Cargo.toml'));
	if (raw === null) return [];
	const { sections, entries } = parseToml(raw);
	const { names, defaultRun } = rustBinaries(directory, sections, entries);
	return [
		// `cargo run` refuses to guess between several binaries.
		...(names.length === 1 || (names.length && defaultRun)
			? [task('Cargo.toml', 'Run', 'cargo', ['run'])]
			: []),
		...(names.length > 1
			? names.map((n) => task('Cargo.toml', `Run ${n}`, 'cargo', ['run', '--bin', n]))
			: []),
		task('Cargo.toml', 'Test Rust packages', 'cargo', ['test']),
		task('Cargo.toml', 'Build Rust packages', 'cargo', ['build']),
		task('Cargo.toml', 'Lint with Clippy', 'cargo', ['clippy']),
		task('Cargo.toml', 'Check formatting', 'cargo', ['fmt', '--check'])
	];
}

export function findVirtualenv(directory) {
	const name = VIRTUALENVS.find((n) => isFile(path.join(directory, n, 'pyvenv.cfg')));
	return name ? path.join(directory, name) : null;
}

function pythonRunner(directory, sections) {
	const hasTable = (table) => [...sections].some((s) => s === table || s.startsWith(`${table}.`));
	if (isFile(path.join(directory, 'uv.lock'))) return ['uv', 'run'];
	if (isFile(path.join(directory, 'poetry.lock')) || hasTable('tool.poetry'))
		return ['poetry', 'run'];
	if (isFile(path.join(directory, 'pdm.lock')) || hasTable('tool.pdm')) return ['pdm', 'run'];
	if (hasTable('tool.hatch.envs')) return ['hatch', 'run'];
	return [];
}

function pythonScripts(sections, entries, runner) {
	const tasks = new Map();
	const add = (name, line) => {
		if (!tasks.has(name)) tasks.set(name, task('pyproject.toml', name, line[0], line.slice(1)));
	};
	for (const { section, key, value } of entries) {
		if (section === 'project.scripts') {
			if (TASK_NAME.test(key) && /^["'][A-Za-z_][\w.]*:[A-Za-z_][\w.]*["']/.test(value))
				add(key, [...runner, key]);
		} else if (section === 'tool.poetry.scripts') {
			if (TASK_NAME.test(key)) add(key, ['poetry', 'run', key]);
		} else if (section === 'tool.pdm.scripts') {
			if (TASK_NAME.test(key) && !key.startsWith('_')) add(key, ['pdm', 'run', key]);
		} else {
			const hatch = section.match(/^tool\.hatch\.envs\.([A-Za-z0-9_-]+)\.scripts$/);
			if (hatch && TASK_NAME.test(key)) {
				const name = hatch[1] === 'default' ? key : `${hatch[1]}:${key}`;
				add(name, ['hatch', 'run', name]);
			}
		}
	}
	// A PDM script can also be a table of its own.
	for (const section of sections) {
		const name = section.match(/^tool\.pdm\.scripts\.([A-Za-z_][A-Za-z0-9_-]*)$/)?.[1];
		if (name && !name.startsWith('_')) add(name, ['pdm', 'run', name]);
	}
	return [...tasks.values()];
}

function pythonTools(directory, raw, sections, runner) {
	const has = (name) => isFile(path.join(directory, name));
	const requirements = listDirectory(directory)
		.filter((e) => e.isFile() && /^requirements.*\.(txt|in)$/.test(e.name))
		.map((e) => readLimited(path.join(directory, e.name)) ?? '')
		.join('\n');
	const declared = `${raw}\n${requirements}`;
	const mentions = (tool) => new RegExp(`\\b${tool}\\b`).test(declared);
	const tool = (name, ...line) => {
		const full = [...runner, ...line];
		return task('Python', name, full[0], full.slice(1));
	};
	const tasks = [];
	const django = /django/i.test(readLimited(path.join(directory, 'manage.py')) ?? '');
	if (django) {
		const python = runner.length || findVirtualenv(directory) ? 'python' : 'python3';
		tasks.push(
			tool('Django server', python, 'manage.py', 'runserver'),
			tool('Django tests', python, 'manage.py', 'test'),
			tool('Django migrate', python, 'manage.py', 'migrate')
		);
	}
	if (
		mentions('pytest') ||
		has('pytest.ini') ||
		has('conftest.py') ||
		has('tests/conftest.py') ||
		(readLimited(path.join(directory, 'setup.cfg')) ?? '').includes('[tool:pytest]')
	)
		tasks.push(tool('pytest', 'pytest'));
	if (mentions('ruff') || has('ruff.toml') || has('.ruff.toml'))
		tasks.push(
			tool('Ruff lint', 'ruff', 'check', '.'),
			tool('Ruff format check', 'ruff', 'format', '--check', '.')
		);
	if (mentions('mypy') || has('mypy.ini')) tasks.push(tool('mypy', 'mypy', '.'));
	if (has('tox.ini') || sections.has('tool.tox')) tasks.push(tool('tox', 'tox'));
	if (has('noxfile.py')) tasks.push(tool('nox', 'nox'));
	return tasks;
}

function pythonTasks(directory) {
	const raw = readLimited(path.join(directory, 'pyproject.toml')) ?? '';
	const { sections, entries } = parseToml(raw);
	const runner = pythonRunner(directory, sections);
	return [
		...pythonScripts(sections, entries, runner),
		...pythonTools(directory, raw, sections, runner)
	];
}

function gradleTasks(directory) {
	const file = firstFile(directory, [
		'build.gradle.kts',
		'build.gradle',
		'settings.gradle.kts',
		'settings.gradle'
	]);
	if (!file) return [];
	const gradle = isFile(path.join(directory, 'gradlew')) ? './gradlew' : 'gradle';
	const build = ['build.gradle.kts', 'build.gradle']
		.map((name) => readLimited(path.join(directory, name)) ?? '')
		.join('\n');
	return [
		...(/org\.springframework\.boot/.test(build)
			? [task(file, 'bootRun', gradle, ['bootRun'])]
			: []),
		...(/['"]application['"]|^\s*application\s*(\{|\(|$)/m.test(build)
			? [task(file, 'run', gradle, ['run'])]
			: []),
		task(file, 'test', gradle, ['test']),
		task(file, 'build', gradle, ['build'])
	];
}

function mavenTasks(directory) {
	const raw = readLimited(path.join(directory, 'pom.xml'));
	if (raw === null) return [];
	const maven = isFile(path.join(directory, 'mvnw')) ? './mvnw' : 'mvn';
	return [
		...(/spring-boot/.test(raw)
			? [task('pom.xml', 'spring-boot:run', maven, ['spring-boot:run'])]
			: []),
		task('pom.xml', 'test', maven, ['test']),
		task('pom.xml', 'package', maven, ['package'])
	];
}

function phpTasks(directory) {
	const parsed = readJson(path.join(directory, 'composer.json'));
	const scripts = parsed?.scripts;
	const composer =
		scripts && typeof scripts === 'object' && !Array.isArray(scripts)
			? Object.keys(scripts)
					// Composer runs pre- and post- scripts itself, on its own events.
					.filter((name) => SCRIPT_NAME.test(name) && !/^(pre|post)-/.test(name))
					.sort()
					.map((name) =>
						task(
							'composer.json',
							name,
							'composer',
							['run-script', name],
							[scripts[name]].flat().join(' && ')
						)
					)
			: [];
	const artisan = isFile(path.join(directory, 'artisan'));
	const phpunit =
		!artisan && firstFile(directory, ['phpunit.xml', 'phpunit.xml.dist'])
			? [task('phpunit.xml', 'PHPUnit', './vendor/bin/phpunit')]
			: [];
	return [
		...composer,
		...(artisan
			? ['serve', 'test', 'migrate'].map((name) => task('artisan', name, 'php', ['artisan', name]))
			: []),
		...phpunit
	];
}

function rakeNames(raw) {
	const names = new Set();
	for (const match of raw.matchAll(
		/^task\s*\(?\s*(?::([A-Za-z_]\w*)|["']([A-Za-z_][\w:-]*)["']|([A-Za-z_]\w*):)/gm
	))
		names.add(match[1] ?? match[2] ?? match[3]);
	for (const match of raw.matchAll(
		/^\s*(RSpec::Core::RakeTask|Rake::TestTask)\.new(?:\(?\s*:([A-Za-z_]\w*))?/gm
	))
		names.add(match[2] ?? (match[1] === 'Rake::TestTask' ? 'test' : 'spec'));
	return [...names].sort();
}

function rubyTasks(directory) {
	const gemfile = readLimited(path.join(directory, 'Gemfile'));
	const rakefile = firstFile(directory, ['Rakefile', 'rakefile', 'Rakefile.rb']);
	const bundled = (...line) => (gemfile === null ? line : ['bundle', 'exec', ...line]);
	const rake = rakefile
		? rakeNames(readLimited(path.join(directory, rakefile)) ?? '').map((name) => {
				const [command, ...args] = bundled('rake', name);
				return task(rakefile, name, command, args);
			})
		: [];
	const rails = isFile(path.join(directory, 'bin/rails'))
		? ['server', 'test', 'db:migrate'].map((name) => task('bin/rails', name, './bin/rails', [name]))
		: [];
	const gems = [];
	if (/\brspec\b/.test(gemfile ?? '') && isDirectory(path.join(directory, 'spec')))
		gems.push(task('Gemfile', 'RSpec', 'bundle', ['exec', 'rspec']));
	if (/\brubocop\b/.test(gemfile ?? ''))
		gems.push(task('Gemfile', 'RuboCop', 'bundle', ['exec', 'rubocop']));
	return [...rails, ...rake, ...gems];
}

function elixirTasks(directory) {
	const raw = readLimited(path.join(directory, 'mix.exs'));
	if (raw === null) return [];
	return [
		...(/:phoenix\b/.test(raw) ? [task('mix.exs', 'phx.server', 'mix', ['phx.server'])] : []),
		task('mix.exs', 'test', 'mix', ['test']),
		task('mix.exs', 'compile', 'mix', ['compile']),
		task('mix.exs', 'Check formatting', 'mix', ['format', '--check-formatted'])
	];
}

function dotnetTasks(directory) {
	const names = listDirectory(directory)
		.filter((e) => e.isFile())
		.map((e) => e.name)
		.sort();
	const solutions = names.filter((n) => /\.(sln|slnx)$/.test(n));
	const projects = names.filter((n) => /\.(csproj|fsproj|vbproj)$/.test(n));
	const targets = [...solutions, ...projects];
	if (!targets.length) return [];
	const source = targets[0];
	// `dotnet` refuses to choose when a folder holds more than one solution or project.
	const target = targets.length > 1 ? [source] : [];
	const runnable = (name) =>
		/<OutputType>\s*(Win)?Exe|Microsoft\.NET\.Sdk\.(Web|Worker)/i.test(
			readLimited(path.join(directory, name)) ?? ''
		);
	return [
		...(projects.length === 1 && runnable(projects[0])
			? [task(source, 'Run', 'dotnet', ['run', '--project', projects[0]])]
			: []),
		task(source, 'Test', 'dotnet', ['test', ...target]),
		task(source, 'Build', 'dotnet', ['build', ...target])
	];
}

function denoTasks(directory) {
	const file = firstFile(directory, ['deno.json', 'deno.jsonc']);
	if (!file) return [];
	const tasks = readJson(path.join(directory, file), stripJsonComments)?.tasks;
	const declared =
		tasks && typeof tasks === 'object' && !Array.isArray(tasks)
			? Object.keys(tasks)
					.filter((name) => SCRIPT_NAME.test(name))
					.sort()
					.map((name) => {
						const value = tasks[name];
						const detail = typeof value === 'string' ? value : (value?.command ?? '');
						return task(file, name, 'deno', ['task', name], String(detail));
					})
			: [];
	return [...declared, task(file, 'Test with Deno', 'deno', ['test'])];
}

function taskfileNames(raw) {
	const names = new Set();
	let inTasks = false;
	let indent = null;
	let current = null;
	for (const line of raw.split(/\r?\n/)) {
		const text = line.trim();
		if (!text || text.startsWith('#')) continue;
		const depth = line.length - line.trimStart().length;
		if (depth === 0) {
			inTasks = /^tasks:\s*(#.*)?$/.test(line);
			indent = null;
			current = null;
		} else if (inTasks) {
			indent ??= depth;
			if (depth === indent) {
				current = text.match(/^(["']?)([A-Za-z_][A-Za-z0-9_:.-]*)\1:(\s|$)/)?.[2] ?? null;
				if (current) names.add(current);
			} else if (current && /^internal:\s*true\b/.test(text)) names.delete(current);
		}
	}
	return [...names];
}

function taskfileTasks(directory) {
	const file = firstFile(directory, [
		'Taskfile.yml',
		'Taskfile.yaml',
		'taskfile.yml',
		'taskfile.yaml',
		'Taskfile.dist.yml',
		'Taskfile.dist.yaml'
	]);
	if (!file) return [];
	return taskfileNames(readLimited(path.join(directory, file)) ?? '').map((name) =>
		task(file, name, 'task', [name])
	);
}

// Top-level `name:` rules, which can name several targets at once. Variables, conditionals, pattern
// rules and anything computed don't match.
function makeTargets(raw) {
	const names = new Set();
	let inDefine = false;
	for (const line of raw.split(/\r?\n/)) {
		if (inDefine) {
			if (/^\s*endef\b/.test(line)) inDefine = false;
			continue;
		}
		if (/^\s*(?:(?:override|export|private)\s+)*define\b/.test(line)) {
			inDefine = true;
			continue;
		}
		if (!line || line[0] === ' ' || line[0] === '\t' || line[0] === '#') continue;
		const colon = line.indexOf(':');
		if (colon < 0 || /^:*=/.test(line.slice(colon + 1))) continue;
		const head = line.slice(0, colon);
		if (/[=$%()]/.test(head)) continue;
		const words = head.trim().split(/\s+/);
		if (MAKE_DIRECTIVES.has(words[0]) || words[0].startsWith('-')) continue;
		for (const word of words) if (TASK_NAME.test(word)) names.add(word);
	}
	return [...names];
}

// A recipe's name, if it can run with no arguments: every parameter has a default or is `*variadic`.
function justRecipeName(line) {
	const start = line.match(/^@?([A-Za-z_][A-Za-z0-9_-]*)/);
	if (!start) return null;
	let quote = '';
	let colon = -1;
	for (let i = start[0].length; i < line.length && colon < 0; i++) {
		const c = line[i];
		if (quote) {
			if (c === quote) quote = '';
		} else if (c === '"' || c === "'") quote = c;
		else if (c === ':') colon = i;
	}
	if (colon < 0 || line[colon + 1] === '=') return null;
	const parameters = line.slice(start[0].length, colon);
	for (const match of parameters.matchAll(
		/(?:^|\s)\$?([*+]?)\$?[A-Za-z_][A-Za-z0-9_-]*(=(?:"[^"]*"|'[^']*'|\S+))?/g
	))
		if (match[1] !== '*' && !match[2]) return null;
	return start[1];
}

function justRecipes(raw) {
	const names = new Set();
	let hidden = false;
	for (const line of raw.split(/\r?\n/)) {
		if (!line || line[0] === ' ' || line[0] === '\t' || line[0] === '#') continue;
		if (line[0] === '[') {
			if (/\bprivate\b/.test(line)) hidden = true;
			continue;
		}
		const name = justRecipeName(line);
		// A leading underscore is Just's convention for a private recipe.
		if (name && !hidden && !name.startsWith('_')) names.add(name);
		hidden = false;
	}
	return [...names];
}

// A case-insensitive filesystem opens Makefile and makefile as one file, so they're listed once.
function makeAndJustTasks(directory) {
	const tasks = [];
	const inspected = new Set();
	for (const file of ['Makefile', 'makefile', 'GNUmakefile', 'justfile', 'Justfile', '.justfile']) {
		const full = path.join(directory, file);
		if (!isFile(full)) continue;
		const stat = fs.statSync(full);
		const identity = `${stat.dev}:${stat.ino}`;
		if (inspected.has(identity)) continue;
		inspected.add(identity);
		const raw = readLimited(full);
		if (raw === null) continue;
		if (file.toLowerCase().endsWith('justfile')) {
			for (const name of justRecipes(raw)) tasks.push(task(file, name, 'just', [name]));
		} else {
			for (const name of makeTargets(raw)) tasks.push(task(file, name, 'make', ['-f', file, name]));
		}
	}
	return tasks;
}

function composeTasks(directory, composeProject) {
	const file = COMPOSE_FILES.find((f) => isFile(path.join(directory, f)));
	if (!file) return [];
	// Foreground `up`, so its output streams here and Stop stops the containers.
	const base = ['compose', ...(composeProject ? ['-p', composeProject] : []), '-f', file];
	return [
		task(file, 'Compose up', 'docker', [...base, 'up']),
		task(file, 'Compose down', 'docker', [...base, 'down'])
	];
}

export function discoverCommands(directory, { composeProject } = {}) {
	return [
		...javascriptTasks(directory),
		...denoTasks(directory),
		...goTasks(directory),
		...rustTasks(directory),
		...pythonTasks(directory),
		...gradleTasks(directory),
		...mavenTasks(directory),
		...phpTasks(directory),
		...rubyTasks(directory),
		...elixirTasks(directory),
		...dotnetTasks(directory),
		...taskfileTasks(directory),
		...makeAndJustTasks(directory),
		...composeTasks(directory, composeProject)
	];
}
