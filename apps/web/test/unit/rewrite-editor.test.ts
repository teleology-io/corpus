// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Markdown } from '@tiptap/markdown';
import {
	RewriteTarget,
	applyRewrite,
	captureSelection,
	rewritePreviewHtml,
	setRewriteTarget
} from '../../src/lib/components/notes/rewrite-editor.js';

let editor: Editor;

function setup(content: JSONContent[]) {
	editor = new Editor({
		// TrailingNode always appends an empty paragraph at the end of the doc, which is unrelated.
		extensions: [
			StarterKit.configure({ trailingNode: false }),
			TaskList,
			TaskItem,
			Markdown,
			RewriteTarget
		],
		content: { type: 'doc', content }
	});
	return editor;
}

const p = (text: string): JSONContent => ({
	type: 'paragraph',
	content: [{ type: 'text', text }]
});
const list = (...items: string[]): JSONContent => ({
	type: 'bulletList',
	content: items.map((text) => ({ type: 'listItem', content: [p(text)] }))
});

/** Selects from the first character of `start` to the last character of `end`. */
function select(start: string, end = start) {
	let from = -1;
	let to = -1;
	editor.state.doc.descendants((node, pos) => {
		if (!node.isText) return;
		const a = node.text!.indexOf(start);
		if (from < 0 && a >= 0) from = pos + a;
		const b = node.text!.lastIndexOf(end);
		if (b >= 0) to = pos + b + end.length;
	});
	editor.commands.setTextSelection({ from, to });
}

function rewrite(output: string) {
	const captured = captureSelection(editor)!;
	expect(applyRewrite(editor, captured, output)).toBe(true);
}

const types = () => editor.getJSON().content!.map((node) => node.type);

afterEach(() => editor?.destroy());

describe('formatted rewrite output', () => {
	it('replaces a whole paragraph with a bullet list, leaving no empty paragraphs', () => {
		setup([p('before'), p('apples and pears'), p('after')]);
		select('apples and pears');
		rewrite('- apples\n- pears');
		expect(editor.getJSON().content).toEqual([p('before'), list('apples', 'pears'), p('after')]);
	});

	it('renders numbered lists, headings, and inline marks as real nodes', () => {
		setup([p('text')]);
		select('text');
		rewrite('## Plan\n\n1. **First** step\n2. *Second* step');
		expect(types()).toEqual(['heading', 'orderedList']);
		const html = editor.getHTML();
		expect(html).toContain('<strong>First</strong>');
		expect(html).toContain('<em>Second</em>');
	});

	it('keeps a list a list when every item is rewritten', () => {
		setup([p('intro'), list('one', 'two'), p('outro')]);
		select('one', 'two');
		rewrite('- first\n- second\n- third');
		expect(editor.getJSON().content).toEqual([
			p('intro'),
			list('first', 'second', 'third'),
			p('outro')
		]);
	});

	it('merges returned items into the list when only some are rewritten', () => {
		setup([list('one', 'two', 'three')]);
		select('two');
		rewrite('- 2a\n- 2b');
		expect(editor.getJSON().content).toEqual([list('one', '2a', '2b', 'three')]);
	});

	it('replaces several paragraphs with a list', () => {
		setup([p('one'), p('two'), p('keep')]);
		select('one', 'two');
		rewrite('- one\n- two');
		expect(editor.getJSON().content).toEqual([list('one', 'two'), p('keep')]);
	});

	it('keeps replacing part of a sentence inline', () => {
		setup([p('The quick fox ran.')]);
		select('quick fox');
		rewrite('**fast** fox');
		expect(types()).toEqual(['paragraph']);
		expect(editor.getText()).toBe('The fast fox ran.');
		expect(editor.getHTML()).toContain('<strong>fast</strong>');
	});

	it('keeps the block type when a heading is rewritten as plain text', () => {
		setup([{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Titel' }] }]);
		select('Titel');
		rewrite('Title');
		expect(types()).toEqual(['heading']);
		expect(editor.getText()).toBe('Title');
	});

	it('sends the model Markdown that keeps the selected structure', () => {
		setup([list('one', 'two')]);
		select('one', 'two');
		expect(captureSelection(editor)!.markdown).toBe('- one\n- two');
	});

	it('refuses to replace text that changed after capture', () => {
		setup([p('some text')]);
		select('some text');
		const captured = captureSelection(editor)!;
		editor.commands.insertContentAt(2, 'XX');
		expect(applyRewrite(editor, captured, 'new')).toBe(false);
	});

	it('still replaces the captured text after the selection is lost', () => {
		setup([p('keep this'), p('replace me')]);
		select('replace me');
		const captured = captureSelection(editor)!;
		editor.commands.setTextSelection(1);
		expect(applyRewrite(editor, captured, '- done')).toBe(true);
		expect(editor.getJSON().content).toEqual([p('keep this'), list('done')]);
	});
});

describe('invented links', () => {
	it('are removed from what gets written to the note', () => {
		setup([p('some text')]);
		select('some text');
		rewrite('better [text](https://example.com/fake)');
		expect(editor.getText()).toBe('better text');
		expect(editor.getHTML()).not.toContain('example.com/fake');
	});
});

describe('rewrite preview', () => {
	it('renders output as the note will show it', () => {
		setup([p('x')]);
		const html = rewritePreviewHtml(editor, '- **one**\n- two', 'x');
		expect(html).toContain('<ul');
		expect(html).toContain('<strong>one</strong>');
	});

	it('drops images and escapes raw markup', () => {
		setup([p('x')]);
		const html = rewritePreviewHtml(
			editor,
			'![x](https://example.com/a.png)\n\n<img src=x onerror=alert(1)> and text',
			'x'
		);
		expect(html).not.toContain('<img');
		expect(html).not.toContain('onerror=alert');
	});

	it('keeps links from the source and removes invented ones', () => {
		setup([p('x')]);
		const source = 'See the [contract](https://example.com/real).';
		const html = rewritePreviewHtml(
			editor,
			'Read the [contract](https://example.com/real) and [this](https://example.com/fake).',
			source
		);
		expect(html).toContain('href="https://example.com/real"');
		expect(html).not.toContain('example.com/fake');
		expect(html).toContain('this');
	});
});

describe('rewrite highlight', () => {
	it('marks the captured text until it is cleared', () => {
		setup([p('some text')]);
		select('some');
		const captured = captureSelection(editor)!;
		setRewriteTarget(editor, captured);
		expect(editor.view.dom.querySelector('.rewrite-target')?.textContent).toBe('some');
		setRewriteTarget(editor, null);
		expect(editor.view.dom.querySelector('.rewrite-target')).toBeNull();
	});
});
