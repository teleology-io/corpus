import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine, Store } from '../../src/lib/server/wrx/core.js';

type FakeChild = EventEmitter & {
	stdout: EventEmitter & { setEncoding: () => void };
	stderr: EventEmitter & { setEncoding: () => void };
	stdin: { on: () => void; end: (text: string) => void };
	prompt: string;
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
		engine = new Engine(store, () => {}, (() => {
			const child = Object.assign(new EventEmitter(), {
				stdout: stream(),
				stderr: stream(),
				prompt: '',
				stdin: {
					on() {},
					end(text: string) {
						child.prompt = text;
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
