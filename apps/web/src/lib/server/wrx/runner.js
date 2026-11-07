/* eslint-disable @typescript-eslint/ban-ts-comment -- plain JS, like the rest of wrx */
// @ts-nocheck — plain JS, like the rest of wrx.
// Finds the commands a checkout declares, for the Run tab. Only reads known files: nothing here runs
// repository code, and a command is an executable and argument array, never a shell string. Dynamic or
// parameterized declarations are skipped rather than evaluated.
import fs from 'node:fs';
import path from 'node:path';

const READ_LIMIT = 1 << 20;
const TASK_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const PYTHON_ENTRY =
	/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*["'][A-Za-z_][A-Za-z0-9_.]*:[A-Za-z_][A-Za-z0-9_.]*["']\s*(#.*)?$/;
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

function isFile(file) {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

function readLimited(file) {
	let fd;
	try {
		fd = fs.openSync(file, 'r');
		if (!fs.fstatSync(fd).isFile()) return null;
		const buffer = Buffer.alloc(READ_LIMIT);
		return buffer.toString('utf8', 0, fs.readSync(fd, buffer, 0, READ_LIMIT, 0));
	} catch {
		return null;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function task(source, name, command, args = [], detail = '') {
	return { id: `${source}:${name}`, name, source, command, args, detail };
}

export function packageManager(directory, declared) {
	const named = typeof declared === 'string' ? declared.split('@')[0] : '';
	if (PACKAGE_MANAGERS.has(named)) return named;
	return LOCKFILES.find(([file]) => isFile(path.join(directory, file)))?.[1] ?? 'npm';
}

function packageTasks(directory) {
	const raw = readLimited(path.join(directory, 'package.json'));
	if (raw === null) return [];
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	const scripts = parsed?.scripts;
	if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return [];
	const manager = packageManager(directory, parsed.packageManager);
	return Object.keys(scripts)
		.filter((name) => name && !name.startsWith('-') && typeof scripts[name] === 'string')
		.sort()
		.map((name) => task('package.json', name, manager, ['run', name], scripts[name]));
}

// Top-level `name:` rules only. Variables, pattern rules and recipes with parameters don't match.
function ruleNames(raw) {
	const names = new Set();
	for (const line of raw.split(/\r?\n/)) {
		if (!line || line[0] === ' ' || line[0] === '\t' || line[0] === '#') continue;
		const colon = line.indexOf(':');
		if (colon < 0 || line[colon + 1] === '=') continue;
		const name = line.slice(0, colon);
		if (TASK_NAME.test(name)) names.add(name);
	}
	return [...names];
}

function pythonNames(raw) {
	const names = new Set();
	let section = '';
	for (const line of raw.split(/\r?\n/).map((l) => l.trim())) {
		if (line.startsWith('[')) section = line;
		else if (section === '[project.scripts]') {
			const match = line.match(PYTHON_ENTRY);
			if (match) names.add(match[1]);
		}
	}
	return [...names];
}

// A case-insensitive filesystem opens Makefile and makefile as one file, so they're listed once.
function textTasks(directory) {
	const tasks = [];
	const inspected = new Set();
	for (const file of [
		'Makefile',
		'makefile',
		'GNUmakefile',
		'justfile',
		'Justfile',
		'pyproject.toml'
	]) {
		const full = path.join(directory, file);
		if (!isFile(full)) continue;
		const stat = fs.statSync(full);
		const identity = `${stat.dev}:${stat.ino}`;
		if (inspected.has(identity)) continue;
		inspected.add(identity);
		const raw = readLimited(full);
		if (raw === null) continue;
		if (file === 'pyproject.toml') {
			for (const name of pythonNames(raw)) tasks.push(task(file, name, name));
		} else if (file.toLowerCase() === 'justfile') {
			// A leading underscore is Just's convention for a private recipe.
			for (const name of ruleNames(raw))
				if (!name.startsWith('_')) tasks.push(task(file, name, 'just', [name]));
		} else {
			for (const name of ruleNames(raw)) tasks.push(task(file, name, 'make', ['-f', file, name]));
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
	const tasks = packageTasks(directory);
	if (isFile(path.join(directory, 'go.mod')))
		tasks.push(task('go.mod', 'Test Go packages', 'go', ['test', './...']));
	if (isFile(path.join(directory, 'Cargo.toml')))
		tasks.push(task('Cargo.toml', 'Test Rust packages', 'cargo', ['test']));
	return [...tasks, ...textTasks(directory), ...composeTasks(directory, composeProject)];
}

export const commandLine = (t) => [t.command, ...t.args].join(' ');

// Splits a variant's flags the way a shell would split words, and nothing else: `$FOO`, `&&` and
// globs stay literal, since no shell ever sees them.
export function parseFlags(text = '') {
	const args = [];
	let word = null;
	let quote = '';
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === quote) quote = '';
			else if (c === '\\' && quote === '"' && i + 1 < text.length) word += text[++i];
			else word += c;
		} else if (c === '"' || c === "'") {
			quote = c;
			word ??= '';
		} else if (/\s/.test(c)) {
			if (word !== null) args.push(word);
			word = null;
		} else if (c === '\\' && i + 1 < text.length) word = (word ?? '') + text[++i];
		else word = (word ?? '') + c;
	}
	if (quote) throw new Error('Flags have an unclosed quote');
	if (word !== null) args.push(word);
	return args;
}

// `NAME=value` per line. `export` and surrounding quotes are accepted, so a line pasted from a shell
// or dotenv file means what it looks like. Errors name the line, not its text, which may be a secret.
export function parseEnvLines(text = '') {
	const env = {};
	text.split(/\r?\n/).forEach((raw, i) => {
		const line = raw.trim();
		if (!line || line.startsWith('#')) return;
		const match = line.replace(/^export\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
		if (!match) throw new Error(`Use NAME=value for env values (line ${i + 1})`);
		const quoted = match[2].match(/^(["'])(.*)\1$/);
		env[match[1]] = quoted ? quoted[2] : match[2];
	});
	return env;
}

// npm is the one package manager that needs `--` before flags meant for the script.
export function withFlags(task, flags) {
	if (!flags.length) return task;
	return {
		...task,
		args: [...task.args, ...(task.command === 'npm' ? ['--'] : []), ...flags]
	};
}

// Terminal colour and cursor sequences, which a text log can't show.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

// The end of a log as text. A cut at the start would otherwise show half a line, or half a character.
export function readLogTail(file, limit) {
	let fd;
	try {
		fd = fs.openSync(file, 'r');
		const { size } = fs.fstatSync(fd);
		const offset = Math.max(0, size - limit);
		const buffer = Buffer.alloc(size - offset);
		const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
		let text = buffer.toString('utf8', 0, read);
		if (offset) text = text.slice(text.indexOf('\n') + 1);
		return text.replace(ANSI, '');
	} catch (error) {
		if (error.code === 'ENOENT') return '';
		throw error;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}
