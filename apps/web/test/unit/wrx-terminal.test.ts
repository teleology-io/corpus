import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { Terminals } from '../../src/lib/server/wrx/terminal.js';

type Exit = { exitCode: number };
const fakePty = () => {
	const spawned: {
		file: string;
		args: string[];
		options: { cols: number; rows: number; cwd: string; env: Record<string, string> };
		written: string[];
		sizes: [number, number][];
		killed: boolean;
		emit: (data: string) => void;
		exit: (code: number) => void;
	}[] = [];
	const pty = {
		spawn(file: string, args: string[], options: (typeof spawned)[number]['options']) {
			let onData = (_: string) => {};
			let onExit = (_: Exit) => {};
			const proc = {
				file,
				args,
				options,
				written: [] as string[],
				sizes: [] as [number, number][],
				killed: false,
				cols: options.cols,
				rows: options.rows,
				emit: (data: string) => onData(data),
				exit: (code: number) => onExit({ exitCode: code }),
				onData: (fn: typeof onData) => (onData = fn),
				onExit: (fn: typeof onExit) => (onExit = fn),
				write: (data: string) => proc.written.push(data),
				resize: (c: number, r: number) => proc.sizes.push([c, r]),
				kill: () => (proc.killed = true)
			};
			spawned.push(proc);
			return proc;
		}
	};
	return { spawned, terminals: new Terminals(async () => pty) };
};

describe('Terminals', () => {
	it('starts one login shell per workspace in its checkout, and reattaches', async () => {
		const { spawned, terminals } = fakePty();
		const env = { SHELL: '/bin/zsh', PORT: '20000' };
		expect(await terminals.open('w', { cwd: '/repo', env, cols: 100, rows: 30 })).toEqual({
			created: true
		});
		expect(spawned[0]).toMatchObject({ file: '/bin/zsh', args: ['-l'] });
		expect(spawned[0].options).toMatchObject({
			cwd: '/repo',
			cols: 100,
			rows: 30,
			env: { PORT: '20000', TERM: 'xterm-256color' }
		});
		expect(await terminals.open('w', { cwd: '/repo', env, cols: 90, rows: 20 })).toEqual({
			created: false
		});
		expect(spawned).toHaveLength(1);
		expect(spawned[0].sizes).toEqual([[90, 20]]);
	});

	it('replays the screen so far to a new viewer, then streams', async () => {
		const { spawned, terminals } = fakePty();
		await terminals.open('w', { cwd: '/', env: {}, cols: 80, rows: 24 });
		spawned[0].emit('$ ');
		const seen: [string, unknown][] = [];
		const off = terminals.subscribe('w', (type: string, data: unknown) => seen.push([type, data]));
		spawned[0].emit('ls\r\n');
		off();
		spawned[0].emit('ignored');
		expect(seen).toEqual([
			['reset', undefined],
			['data', '$ '],
			['data', 'ls\r\n']
		]);
	});

	it('writes input, clamps sizes and ends the session on exit', async () => {
		const { spawned, terminals } = fakePty();
		await terminals.open('w', { cwd: '/', env: {}, cols: 0, rows: 99999 });
		expect(spawned[0].options).toMatchObject({ cols: 80, rows: 1000 });
		terminals.write('w', 'echo hi\r');
		expect(spawned[0].written).toEqual(['echo hi\r']);
		const seen: string[] = [];
		terminals.subscribe('w', (type: string) => seen.push(type));
		spawned[0].exit(0);
		expect(seen.at(-1)).toBe('exit');
		expect(terminals.has('w')).toBe(false);
		expect(() => terminals.write('w', 'x')).toThrow(/closed/);
		const late: string[] = [];
		terminals.subscribe('w', (type: string) => late.push(type));
		expect(late).toEqual(['exit']);
	});

	it('kills every shell on close', async () => {
		const { spawned, terminals } = fakePty();
		await terminals.open('a', { cwd: '/', env: {}, cols: 80, rows: 24 });
		await terminals.open('b', { cwd: '/', env: {}, cols: 80, rows: 24 });
		terminals.closeAll();
		expect(spawned.map((p) => p.killed)).toEqual([true, true]);
	});

	it.skipIf(process.platform === 'win32')('runs a real shell through node-pty', async () => {
		const terminals = new Terminals();
		await terminals.open('real', {
			cwd: os.tmpdir(),
			env: { SHELL: '/bin/sh', PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.homedir() },
			cols: 80,
			rows: 24
		});
		const output = await new Promise<string>((resolve) => {
			let text = '';
			terminals.subscribe('real', (type: string, data: unknown) => {
				if (type === 'data') text += data;
				if (type === 'exit') resolve(text);
			});
			terminals.write('real', 'echo pty-$((6*7)); exit\r');
		});
		expect(output).toContain('pty-42');
	});
});
