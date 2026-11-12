/* eslint-disable @typescript-eslint/ban-ts-comment -- plain JS, like the rest of wrx */
// @ts-nocheck — plain JS, like the rest of wrx.
// Run tab terminal: a real shell on a pseudo-terminal, one per workspace. Output reaches the browser
// over SSE (terminal-stream); keystrokes and resizes come back as POSTs. A tail of the output is
// kept so a reload, or a second browser tab, redraws the screen where it was.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const REPLAY_LIMIT = 256 * 1024;
const MAX_SIZE = 1000;

let loading = null;
// node-pty is a native module, loaded on first use so the rest of Workbench works without it.
export function loadPty() {
	loading ??= (async () => {
		// The macOS prebuilds ship spawn-helper without its executable bit, and pnpm doesn't run the
		// package's scripts, so every spawn fails with "posix_spawnp failed" until it's set.
		try {
			const root = path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
			const helper = path.join(
				root,
				'prebuilds',
				`${process.platform}-${process.arch}`,
				'spawn-helper'
			);
			const stat = fs.statSync(helper, { throwIfNoEntry: false });
			if (stat && !(stat.mode & 0o111)) fs.chmodSync(helper, 0o755);
		} catch {
			// No prebuild for this platform: node-pty was compiled, with its own helper.
		}
		const mod = await import('node-pty');
		return mod.default ?? mod;
	})().catch((error) => {
		loading = null;
		throw new Error(`The terminal needs node-pty, which couldn't be loaded: ${error.message}`);
	});
	return loading;
}

const size = (value, fallback) => {
	const n = Math.floor(Number(value));
	return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_SIZE) : fallback;
};

export class Terminals {
	constructor(load = loadPty) {
		this.load = load;
		this.sessions = new Map();
	}
	has(workspaceId) {
		return this.sessions.has(workspaceId);
	}
	// Opening a workspace's terminal again attaches to the shell that's already there.
	async open(workspaceId, { cwd, env, cols, rows }) {
		const pty = await this.load();
		const existing = this.sessions.get(workspaceId);
		if (existing) {
			this.resize(workspaceId, cols, rows);
			return { created: false };
		}
		const windows = process.platform === 'win32';
		const shell = windows ? 'powershell.exe' : env.SHELL || process.env.SHELL || '/bin/sh';
		const proc = pty.spawn(shell, windows ? [] : ['-l'], {
			name: 'xterm-256color',
			cols: size(cols, 80),
			rows: size(rows, 24),
			cwd,
			env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
		});
		const session = { proc, buffer: '', listeners: new Set() };
		proc.onData((data) => {
			session.buffer += data;
			if (session.buffer.length > REPLAY_LIMIT)
				session.buffer = session.buffer.slice(-REPLAY_LIMIT);
			for (const listener of session.listeners) listener('data', data);
		});
		proc.onExit(({ exitCode }) => {
			if (this.sessions.get(workspaceId) === session) this.sessions.delete(workspaceId);
			for (const listener of session.listeners) listener('exit', exitCode);
			session.listeners.clear();
		});
		this.sessions.set(workspaceId, session);
		return { created: true };
	}
	write(workspaceId, data) {
		const session = this.sessions.get(workspaceId);
		if (!session) throw new Error('This terminal has closed');
		if (typeof data !== 'string') throw new Error('Terminal input must be text');
		session.proc.write(data);
	}
	resize(workspaceId, cols, rows) {
		const session = this.sessions.get(workspaceId);
		if (!session) return;
		try {
			session.proc.resize(size(cols, session.proc.cols), size(rows, session.proc.rows));
		} catch {
			// The shell exited between the check and the resize.
		}
	}
	// Sends what's on screen so far, then everything new, until the shell exits or `listener` is removed.
	subscribe(workspaceId, listener) {
		const session = this.sessions.get(workspaceId);
		if (!session) {
			listener('exit', null);
			return () => {};
		}
		listener('reset');
		if (session.buffer) listener('data', session.buffer);
		session.listeners.add(listener);
		return () => session.listeners.delete(listener);
	}
	close(workspaceId) {
		const session = this.sessions.get(workspaceId);
		if (!session) return;
		try {
			session.proc.kill();
		} catch {
			// Already gone; onExit cleans up.
		}
	}
	closeAll() {
		for (const workspaceId of this.sessions.keys()) this.close(workspaceId);
	}
}
