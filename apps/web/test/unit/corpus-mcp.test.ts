import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { z } from 'zod';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { noteDocument } from '../../src/lib/server/mcp/note-doc.js';
import { handleMessage, tool } from '../../src/lib/server/mcp/protocol.js';
import { agentArgs, Engine, parseMcpList, Store } from '../../src/lib/server/wrx/core.js';

const define = tool<null>();
const tools = [
	define({ name: 'look', description: '', write: false, input: z.object({}), run: async () => 1 }),
	define({
		name: 'change',
		description: '',
		write: true,
		input: z.object({ n: z.number() }),
		run: async (_c, i) => i.n
	})
];
type Reply = { result: { tools: { name: string }[]; isError?: boolean } };
const send = (method: string, params: object, canWrite: boolean) =>
	handleMessage(
		{ jsonrpc: '2.0', id: 1, method, params },
		{
			tools,
			canWrite,
			context: async () => null,
			instructions: ''
		}
	) as unknown as Promise<Reply>;

describe('corpus MCP protocol', () => {
	it('hides and refuses write tools for read-only agents', async () => {
		expect((await send('tools/list', {}, false)).result.tools.map((t) => t.name)).toEqual(['look']);
		expect((await send('tools/list', {}, true)).result.tools).toHaveLength(2);
		const call = { name: 'change', arguments: { n: 2 } };
		expect((await send('tools/call', call, false)).result.isError).toBe(true);
		expect((await send('tools/call', call, true)).result.isError).toBeUndefined();
	});
	it('rejects bad input', async () => {
		const r = await send('tools/call', { name: 'change', arguments: { n: 'x' } }, true);
		expect(r.result.isError).toBe(true);
	});
	it('does not answer notifications', async () => {
		expect(
			await handleMessage(
				{ jsonrpc: '2.0', method: 'notifications/initialized' },
				{ tools, canWrite: false, context: async () => null, instructions: '' }
			)
		).toBeNull();
	});
});

describe('agent MCP access', () => {
	let dir: string;
	let engine: Engine;
	let spawned: { args: string[]; env: Record<string, string>; child: EventEmitter }[];
	const token = (i: number) => spawned[i]!.env.CORPUS_MCP_TOKEN!;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-mcp-'));
		spawned = [];
		const store = new Store(dir);
		store.state.workspaces.push({ id: 'w', path: dir, branch: 'main' });
		engine = new Engine(store, () => {}, ((
			_bin: string,
			args: string[],
			o: { env: Record<string, string> }
		) => {
			const stream = () => Object.assign(new EventEmitter(), { setEncoding() {} });
			const child = Object.assign(new EventEmitter(), {
				stdout: stream(),
				stderr: stream(),
				stdin: { on() {}, end() {}, write() {} }
			});
			spawned.push({ args, env: o.env, child });
			return child;
		}) as never);
		engine.mcpUrl = 'http://localhost:2222/api/mcp' as never;
	});
	afterEach(() => {
		engine.flushChanges();
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const start = (provider: string, mode: string) => {
		const chat = engine.chat({ workspaceId: 'w', title: 'T', members: [{ provider, mode }] });
		engine.turn(chat.id, 'go');
		return chat;
	};

	it('keeps the token out of argv and resolves it to its agent', () => {
		const chat = start('claude', 'implement');
		expect(spawned[0]!.args.join(' ')).not.toContain(token(0));
		expect(spawned[0]!.args).toContain('mcp__corpus');
		expect(engine.mcpAgent(token(0))).toMatchObject({ chat: { id: chat.id }, canWrite: true });
		expect(engine.mcpAgent('nope')).toBeNull();
	});
	it('follows permission changes from the agent dialog', () => {
		const chat = start('claude', 'assess');
		const m = chat.members[0];
		expect(engine.mcpAgent(token(0))!.canWrite).toBe(false);
		m.status = 'idle';
		const old = token(0);
		engine.updateMember(chat.id, m.id, { mode: 'implement' });
		// The old process and its token are gone; the next turn's token may write.
		expect(engine.mcpAgent(old)).toBeNull();
		engine.running.clear();
		engine.turn(chat.id, 'again');
		expect(engine.mcpAgent(token(1))!.canWrite).toBe(true);
		// Read at call time, so even a token still held loses writes at once.
		m.mode = 'review';
		expect(engine.mcpAgent(token(1))!.canWrite).toBe(false);
	});
	it('revokes a Codex token when its turn ends', () => {
		start('codex', 'assess');
		expect(engine.mcpAgent(token(0))).not.toBeNull();
		spawned[0]!.child.emit('close', 0);
		expect(engine.mcpAgent(token(0))).toBeNull();
	});
	it('gives ticket threads no Corpus tools', () => {
		const chat = engine.chat({ workspaceId: 'w', members: [{ provider: 'claude' }] });
		chat.corpusTools = false;
		engine.turn(chat.id, 'go');
		expect(token(0)).toBeUndefined();
		expect(spawned[0]!.args).not.toContain('--mcp-config');
	});
	it('gives account servers only to agents that may write', () => {
		const a = { provider: 'claude', mode: 'implement', mcp: ['claude.ai Gmail', 'corpus'] };
		expect(agentArgs(a)).toContain('mcp__claude_ai_Gmail');
		expect(agentArgs({ ...a, mode: 'assess' })).not.toContain('--allowedTools');
		const c = { provider: 'codex', mode: 'implement', mcp: ['linear', 'a.b'] };
		expect(agentArgs(c).filter((x) => x.startsWith('mcp_servers'))).toEqual([
			'mcp_servers.linear.default_tools_approval_mode="approve"'
		]);
	});
	it('parses the CLIs’ server lists', () => {
		const out =
			'Checking MCP server health…\n\nclaude.ai Gmail: https://x - ✔ Connected\nplugin:a:b: npx -y c - ✘ Failed\n';
		expect(parseMcpList('claude', out)).toEqual([
			{ name: 'claude.ai Gmail', status: 'Connected' },
			{ name: 'plugin:a:b', status: 'Failed' }
		]);
		expect(parseMcpList('codex', '[{"name":"linear","enabled":true}]')).toHaveLength(1);
	});
});

describe('notes from Markdown', () => {
	it('produces a document the editor schema accepts', () => {
		const md =
			'# Plan\n\nSome **bold *both*** and `a < b` [x](https://e.com) [bad](javascript:alert(1)) end\n\n- one\n  - nested\n- two\n\n1. first\n\n- [ ] todo\n- [x] done\n\n> quote\n\n```ts\nconst a = 1;\n```\n\n---\n';
		const { ydoc, contentText } = noteDocument(md);
		const doc = new Y.Doc();
		Y.applyUpdate(doc, ydoc);
		const schema = getSchema([
			StarterKit.configure({ undoRedo: false }),
			TaskList,
			TaskItem.configure({ nested: true })
		]);
		const root = yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment('default'), schema);
		root.check();
		const json = JSON.stringify(root.toJSON());
		expect(json).not.toContain('javascript:');
		expect(json).toContain('"checked":true');
		for (const t of ['taskList', 'orderedList', 'codeBlock', 'blockquote', 'horizontalRule'])
			expect(json).toContain(`"${t}"`);
		// Text after a link or code run carries none of its marks.
		expect(json).toContain('{"type":"text","text":" bad end"}');
		expect(contentText).toContain('a < b');
	});
});
