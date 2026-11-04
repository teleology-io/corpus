import { describe, expect, it } from 'vitest';
import {
	buildRewriteMessages,
	cleanRewriteOutput,
	maxNewTokens
} from '../../src/lib/components/notes/rewrite-prompts.js';

describe('buildRewriteMessages', () => {
	it('wraps the selected text and states the task', () => {
		const [system, user] = buildRewriteMessages('grammar', 'teh cat');
		expect(system.role).toBe('system');
		expect(user.content).toContain('Fix spelling and grammar');
		expect(user.content).toContain('<text>\nteh cat\n</text>');
	});

	it('uses the instruction for custom actions', () => {
		const user = buildRewriteMessages('custom', 'hello', '  make it formal ').at(-1)!;
		expect(user.content).toBe('Task: make it formal\n\nText:\nhello');
	});

	it('gives only custom instructions examples, which edit actions would copy', () => {
		expect(buildRewriteMessages('improve', 'hello')).toHaveLength(2);
		const custom = buildRewriteMessages('custom', 'hello', 'make a list');
		expect(custom.some((m) => m.role === 'assistant' && m.content.includes('1. '))).toBe(true);
	});

	it('asks to keep a list only when the text is one', () => {
		expect(buildRewriteMessages('improve', '- a\n- b')[1].content).toContain('Keep it as a list');
		expect(buildRewriteMessages('improve', 'a - b')[1].content).not.toContain('Keep it as a list');
	});
});

describe('maxNewTokens', () => {
	it('scales with input up to a cap', () => {
		expect(maxNewTokens(100)).toBe(178);
		expect(maxNewTokens(100000)).toBe(2048);
	});
});

describe('cleanRewriteOutput', () => {
	it('strips wrappers the model added', () => {
		expect(cleanRewriteOutput('  plain text\n', 'x')).toBe('plain text');
		expect(cleanRewriteOutput('```markdown\n**bold**\n```', 'x')).toBe('**bold**');
		expect(cleanRewriteOutput('<text>\nhello\n</text>', 'x')).toBe('hello');
		expect(cleanRewriteOutput('"hello"', 'x')).toBe('hello');
		expect(cleanRewriteOutput('“hello”', 'x')).toBe('hello');
		expect(cleanRewriteOutput('Here is the rewritten text:\n\nhello', 'x')).toBe('hello');
		expect(cleanRewriteOutput("Sure! Here's a clearer version: hello", 'x')).toBe('hello');
	});

	it('strips junk seen from the real model', () => {
		expect(cleanRewriteOutput('- one\n- two\n</|im_end|>', 'x')).toBe('- one\n- two');
		expect(cleanRewriteOutput('Some text.</|', 'x')).toBe('Some text.');
		expect(cleanRewriteOutput('Some text.\n</text>', 'x')).toBe('Some text.');
		expect(cleanRewriteOutput('<summary>\n- one\n</summary>', 'x')).toBe('- one');
	});

	it('keeps quotes that were in the original', () => {
		expect(cleanRewriteOutput('"hello"', '"helo"')).toBe('"hello"');
	});

	it('keeps real content that resembles a lead-in', () => {
		expect(cleanRewriteOutput('Here is the plan: ship it.', 'x')).toBe(
			'Here is the plan: ship it.'
		);
	});
});
