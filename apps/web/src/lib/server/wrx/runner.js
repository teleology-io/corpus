/* eslint-disable @typescript-eslint/ban-ts-comment -- plain JS, like the rest of wrx */
// @ts-nocheck — plain JS, like the rest of wrx.
// How the Run tab turns a command into a process and its output into text.
import fs from 'node:fs';
import path from 'node:path';
import { findVirtualenv } from './discover.js';

// For display and for agents. A task is never run from this string.
export const commandLine = (t) =>
	`${t.cwd ? `cd ${t.cwd} && ` : ''}${[t.command, ...t.args].join(' ')}`;

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

const SHELL_OPERATORS = new Set(['&&', '||', '|', ';', '>', '>>', '<', '&']);

// A custom command's text as an executable and arguments. What would only work in a shell is refused
// here, since it would otherwise fail later with a confusing "isn't installed".
export function parseCommand(text = '') {
	const [command, ...args] = parseFlags(text);
	if (!command) throw new Error('Enter a command to run');
	if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(command))
		throw new Error('Set env values on a variant of this command, not in the command itself');
	if (args.some((arg) => SHELL_OPERATORS.has(arg)))
		throw new Error(`Commands don't run in a shell. To use one, write: sh -c "your command"`);
	return { command, args };
}

// A command saved on the project, as a task like any a checkout declares.
export function customTask(saved) {
	return {
		id: `custom:${saved.id}`,
		name: saved.name,
		source: 'Custom',
		...parseCommand(saved.line),
		detail: '',
		custom: saved.id,
		text: saved.line,
		...(saved.cwd ? { cwd: saved.cwd } : {})
	};
}

// A folder inside the checkout, as a clean relative path. '' is the checkout itself.
export function parseFolder(text = '') {
	const folder = String(text).trim();
	if (!folder) return '';
	const clean = path.posix.normalize(folder.replaceAll('\\', '/')).replace(/\/+$/, '');
	if (path.posix.isAbsolute(clean) || /^[A-Za-z]:/.test(clean) || clean.split('/').includes('..'))
		throw new Error('Folder must be inside this checkout');
	return clean === '.' ? '' : clean;
}

// What activating a project's virtualenv would do, using the nearest one to where the command runs.
export function withVirtualenv(env, ...directories) {
	for (const directory of directories) {
		const venv = findVirtualenv(directory);
		if (!venv) continue;
		const bin = path.join(venv, process.platform === 'win32' ? 'Scripts' : 'bin');
		const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
		return {
			...env,
			VIRTUAL_ENV: venv,
			[pathKey]: env[pathKey] ? `${bin}${path.delimiter}${env[pathKey]}` : bin
		};
	}
	return env;
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
