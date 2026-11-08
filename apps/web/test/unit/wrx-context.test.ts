import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine, Store } from '../../src/lib/server/wrx/core.js';

type FakeChild = EventEmitter & {
	stdout: EventEmitter & { setEncoding: () => void };
	stderr: EventEmitter & { setEncoding: () => void };
	stdin: { on: () => void; end: (text: string) => void; write: (text: string) => void };
	prompt: string;
	writes: number;
	args: string[];
};

const stream = () => Object.assign(new EventEmitter(), { setEncoding() {} });

const agent = (id: string, sessionId: string | null = null) => ({
	id,
	name: id.toUpperCase(),
	handle: id,
	role: '',
	provider: 'claude',
	mode: 'assess',
	model: '',
	color: 0,
	sessionId,
	status: 'idle',
	seen: 0,
	costUsd: 0
});

describe('workbench agent context', () => {
	let dir: string;
	let engine: Engine;
	let children: FakeChild[];

	const reply = (child: FakeChild, text: string) =>
		child.stdout.emit(
			'data',
			`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`
		);
	const finish = (child: FakeChild, session: string) => {
		child.stdout.emit('data', `${JSON.stringify({ session_id: session })}\n`);
		child.emit('close', 0);
	};

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrx-context-'));
		children = [];
		const store = new Store(dir);
		store.state.workspaces.push({ id: 'w', path: dir, branch: 'main' });
		store.state.chats.push({
			id: 'c',
			workspaceId: 'w',
			title: 'Thread',
			status: 'idle',
			members: [agent('a'), agent('b')],
			leadId: 'a',
			messages: [],
			events: []
		});
		engine = new Engine(store, () => {}, ((_bin: string, args: string[]) => {
			const child = Object.assign(new EventEmitter(), {
				stdout: stream(),
				stderr: stream(),
				prompt: '',
				writes: 0,
				args,
				stdin: {
					on() {},
					end(text: string) {
						child.prompt = text;
					},
					// Claude turns arrive as stream-json user lines; keep just their text.
					write(text: string) {
						child.writes++;
						child.prompt = JSON.parse(text)
							.message.content.filter((c: { type: string }) => c.type === 'text')
							.map((c: { text: string }) => c.text)
							.join('');
					}
				}
			}) as FakeChild;
			children.push(child);
			return child;
		}) as never);
	});

	afterEach(() => {
		engine.flushChanges();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('delivers a reply that was still running when a teammate started', () => {
		engine.turn('c', '@a start');
		const [a] = children;
		reply(a, 'partial from a');

		engine.turn('c', '@b look');
		const [, b] = children;
		expect(b.prompt).toContain('@b look');
		expect(b.prompt).not.toContain('partial from a');
		finish(b, 'b-session');

		reply(a, 'final from a');
		finish(a, 'a-session');

		engine.turn('c', '@b again');
		const next = children[2];
		expect(next.prompt).toContain('partial from a\n\nfinal from a');
		expect(next.prompt).toContain('@b again');
		expect(next.prompt).not.toContain('@b look');
	});

	it('does not repeat a withheld reply once it was delivered', () => {
		engine.turn('c', '@a start');
		engine.turn('c', '@b look');
		const [a, b] = children;
		finish(b, 'b-session');
		reply(a, 'final from a');
		finish(a, 'a-session');

		engine.turn('c', '@b again');
		finish(children[2], 'b-session');
		engine.turn('c', '@b third');
		expect(children[3].prompt).toContain('@b third');
		expect(children[3].prompt).not.toContain('final from a');
	});

	it('keeps withholding a reply across turns until it finishes', () => {
		engine.turn('c', '@a start');
		engine.turn('c', '@b look');
		const [a, b] = children;
		reply(a, 'partial from a');
		finish(b, 'b-session');

		engine.turn('c', '@b again');
		expect(children[2].prompt).not.toContain('partial from a');
		finish(children[2], 'b-session');

		finish(a, 'a-session');
		engine.turn('c', '@b third');
		expect(children[3].prompt).toContain('partial from a');
	});
});

describe('persistent Claude sessions', () => {
	let dir: string;
	let engine: Engine;
	let children: FakeChild[];
	const chat = () => engine.store.get('chats', 'c');
	const emit = (child: FakeChild, data: object) =>
		child.stdout.emit('data', `${JSON.stringify(data)}\n`);
	const say = (child: FakeChild, text: string) =>
		emit(child, { type: 'assistant', message: { content: [{ type: 'text', text }] } });
	const result = (child: FakeChild, cost = 0.01) =>
		emit(child, { type: 'result', session_id: 's1', total_cost_usd: cost, duration_ms: 5 });

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrx-session-'));
		children = [];
		vi.spyOn(process, 'kill').mockImplementation(() => true);
		const store = new Store(dir);
		store.state.workspaces.push({ id: 'w', path: dir, branch: 'main' });
		store.state.chats.push({
			id: 'c',
			workspaceId: 'w',
			title: 'Thread',
			status: 'idle',
			members: [agent('a')],
			leadId: 'a',
			messages: [],
			events: []
		});
		engine = new Engine(store, () => {}, ((_bin: string, args: string[]) => {
			const child = Object.assign(new EventEmitter(), {
				pid: 1,
				stdout: stream(),
				stderr: stream(),
				prompt: '',
				writes: 0,
				args,
				stdin: {
					on() {},
					end() {
						throw new Error('Claude stdin must stay open');
					},
					write(text: string) {
						child.writes++;
						child.prompt = JSON.parse(text).message.content[0].text;
					}
				}
			}) as FakeChild;
			children.push(child);
			return child;
		}) as never);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		engine.flushChanges();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('ends the turn on result and reuses the live process for the next message', () => {
		engine.turn('c', 'arm a monitor');
		const [a] = children;
		expect(a.args).toEqual(expect.arrayContaining(['--input-format', 'stream-json']));
		say(a, 'armed');
		result(a);
		const reply = chat().messages.at(-1);
		expect(reply.status).toBe('done');
		expect(reply.costUsd).toBe(0.01);
		expect(chat().members[0].status).toBe('idle');
		expect(chat().members[0].live).toBe(true);

		engine.turn('c', 'hard stop at 5am');
		expect(children).toHaveLength(1);
		expect(a.writes).toBe(2);
		expect(a.prompt).toContain('hard stop at 5am');
		expect(chat().members[0].status).toBe('running');
	});

	it('posts output a background task wakes as its own message', () => {
		engine.turn('c', 'watch the run');
		const [a] = children;
		result(a);
		emit(a, { type: 'system', subtype: 'task_notification' });
		expect(chat().messages).toHaveLength(2);

		say(a, 'GAN finished, e2e started');
		const woke = chat().messages.at(-1);
		expect(woke.by).toBe('background');
		expect(woke.status).toBe('running');
		expect(chat().status).toBe('running');
		result(a, 0.02);
		expect(woke.status).toBe('done');
		expect(woke.text).toBe('GAN finished, e2e started');
		expect(chat().members[0].costUsd).toBeCloseTo(0.03);
	});

	it('queues a message sent during a background turn until it ends', () => {
		engine.turn('c', 'watch');
		const [a] = children;
		result(a);
		say(a, 'stall flagged');
		engine.turn('c', 'what happened?');
		expect(a.writes).toBe(1);
		result(a);
		expect(a.writes).toBe(2);
		expect(a.prompt).toContain('what happened?');
	});

	it('stop ends an idle session and the next message starts a new one', () => {
		engine.turn('c', 'watch');
		const [a] = children;
		result(a);
		engine.cancel('c');
		expect(process.kill).toHaveBeenCalled();
		expect(chat().members[0].live).toBe(false);
		say(a, 'late output from the dying process');
		expect(chat().messages).toHaveLength(2);
		a.emit('close', null);

		engine.turn('c', 'status');
		expect(children).toHaveLength(2);
		expect(children[1].args).toEqual(expect.arrayContaining(['--resume', 's1']));
	});

	it('fails the turn when the process dies mid-turn', () => {
		engine.turn('c', 'go');
		const [a] = children;
		a.stderr.emit('data', 'boom');
		a.emit('close', 1);
		const msg = chat().messages.at(-1);
		expect(msg.status).toBe('failed');
		expect(msg.error).toBe('boom');
		expect(chat().members[0].live).toBe(false);
	});
});
