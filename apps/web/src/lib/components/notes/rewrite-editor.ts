import { Extension, getHTMLFromFragment, type Editor, type JSONContent } from '@tiptap/core';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
	absolutePositionToRelativePosition,
	relativePositionToAbsolutePosition,
	ySyncPluginKey,
	type RelativePosition
} from '@tiptap/y-tiptap';
import { MAX_REWRITE_CHARS } from './rewrite-prompts.js';

/** These don't survive a small model's rewrite reliably, so selections containing them are refused. */
const UNSUPPORTED = new Set(['mention', 'image', 'table', 'codeBlock']);

export interface CapturedSelection {
	/** What the model sees. */
	markdown: string;
	/** Plain text at capture time, compared on apply to detect edits made while rewriting. */
	text: string;
	from: number;
	to: number;
	/** Survives remote edits, which can rebuild the ProseMirror doc and invalidate plain positions. */
	anchors: { from: RelativePosition; to: RelativePosition } | null;
}

const plainText = (doc: PMNode, from: number, to: number) => doc.textBetween(from, to, '\n');

/** Why the current selection can't be rewritten, or null when it can. */
export function rewriteBlockReason(editor: Editor): string | null {
	const { doc, selection } = editor.state;
	const { from, to } = selection;
	if (selection.empty) return 'Select some text to rewrite.';
	let unsupported = false;
	doc.nodesBetween(from, to, (node) => {
		if (UNSUPPORTED.has(node.type.name)) unsupported = true;
		return !unsupported;
	});
	if (unsupported) return "Selections with mentions, images, tables, or code can't be rewritten.";
	if (plainText(doc, from, to).length > MAX_REWRITE_CHARS)
		return `Selection is too long. Rewrite up to ${MAX_REWRITE_CHARS.toLocaleString()} characters at a time.`;
	return null;
}

function anchorRange(state: EditorState, from: number, to: number) {
	const sync = ySyncPluginKey.getState(state);
	if (!sync) return null;
	const { type, binding } = sync;
	return {
		from: absolutePositionToRelativePosition(from, type, binding.mapping),
		to: absolutePositionToRelativePosition(to, type, binding.mapping)
	};
}

function resolveRange(state: EditorState, selection: CapturedSelection) {
	const size = state.doc.content.size;
	let { from, to } = selection;
	const sync = ySyncPluginKey.getState(state);
	if (selection.anchors && sync) {
		const { doc, type, binding } = sync;
		const a = relativePositionToAbsolutePosition(
			doc,
			type,
			selection.anchors.from,
			binding.mapping
		);
		const b = relativePositionToAbsolutePosition(doc, type, selection.anchors.to, binding.mapping);
		if (a === null || b === null) return null;
		from = a;
		to = b;
	}
	return from < to && to <= size ? { from, to } : null;
}

const targetKey = new PluginKey<CapturedSelection | null>('rewriteTarget');

/**
 * Keeps the text being rewritten highlighted once focus moves to the panel, when the browser stops
 * drawing the selection. A local decoration, so collaborators don't see it.
 */
export const RewriteTarget = Extension.create({
	name: 'rewriteTarget',
	addProseMirrorPlugins() {
		return [
			new Plugin<CapturedSelection | null>({
				key: targetKey,
				state: {
					init: () => null,
					apply: (tr, prev) => {
						const next = tr.getMeta(targetKey) as CapturedSelection | null | undefined;
						return next === undefined ? prev : next;
					}
				},
				props: {
					decorations(state) {
						const target = targetKey.getState(state);
						const range = target && resolveRange(state, target);
						if (!range) return null;
						return DecorationSet.create(state.doc, [
							Decoration.inline(range.from, range.to, { class: 'rewrite-target' })
						]);
					}
				}
			})
		];
	}
});

export function setRewriteTarget(editor: Editor, target: CapturedSelection | null) {
	if (editor.isDestroyed) return;
	editor.view.dispatch(editor.state.tr.setMeta(targetKey, target).setMeta('addToHistory', false));
}

export function captureSelection(editor: Editor): CapturedSelection | null {
	const { state } = editor;
	const { doc, selection } = state;
	const { from, to, $from } = selection;
	if (selection.empty || !editor.markdown) return null;
	// The slice is cut at the selection's shared ancestor, so rebuild enough around it to be valid
	// Markdown: bare inline text needs a paragraph, and bare list items need their list.
	const parent = $from.node($from.sharedDepth(to));
	const content = (doc.slice(from, to).content.toJSON() ?? []) as JSONContent[];
	const nodes: JSONContent[] = parent.isTextblock
		? [{ type: 'paragraph', content }]
		: parent.type.name === 'doc'
			? content
			: [{ ...(parent.toJSON() as JSONContent), content }];
	return {
		markdown: editor.markdown.serialize({ type: 'doc', content: nodes }).trim(),
		text: plainText(doc, from, to),
		from,
		to,
		anchors: anchorRange(state, from, to)
	};
}

/**
 * Small models invent URLs, and output must not make the preview or the note fetch one. So images
 * are dropped, and a link keeps its text but loses its mark unless the source had that URL.
 */
function sanitize(nodes: JSONContent[], source: string): JSONContent[] {
	return nodes
		.filter((node) => node.type !== 'image')
		.map((node) => {
			const clean = { ...node };
			if (node.content) clean.content = sanitize(node.content, source);
			if (node.marks) {
				clean.marks = node.marks.filter(
					(mark) => mark.type !== 'link' || source.includes(String(mark.attrs?.href))
				);
				if (!clean.marks.length) delete clean.marks;
			}
			return clean;
		});
}

const parseOutput = (editor: Editor, output: string, source: string) =>
	sanitize(editor.markdown?.parse(output).content ?? [], source);

/**
 * The output as the note will show it, or null if it can't be rendered. Goes through the editor's
 * schema and serializer, so only markup the editor itself would produce comes out.
 */
export function rewritePreviewHtml(editor: Editor, output: string, source: string) {
	try {
		const { schema } = editor;
		const blocks = parseOutput(editor, output, source);
		return getHTMLFromFragment(Fragment.fromJSON(schema, blocks), schema);
	} catch {
		return null;
	}
}

/** The enclosing blocks when the selection covers them exactly, so new blocks can replace them. */
function wholeBlocks(doc: PMNode, from: number, to: number) {
	const $from = doc.resolve(from);
	const $to = doc.resolve(to);
	if ($from.parentOffset !== 0 || $to.parentOffset !== $to.parent.content.size) return null;
	let depth = $from.parent === $to.parent ? $from.depth : $from.sharedDepth(to) + 1;
	for (let d = depth; d < $from.depth; d++) if ($from.index(d) !== 0) return null;
	for (let d = depth; d < $to.depth; d++)
		if ($to.index(d) !== $to.node(d).childCount - 1) return null;
	// Everything inside the wrapper is selected (a whole list, say), so replace the wrapper too.
	while (
		depth > 1 &&
		$from.index(depth - 1) === 0 &&
		$to.index(depth - 1) === $to.node(depth - 1).childCount - 1
	)
		depth--;
	return { from: $from.before(depth), to: $to.after(depth), parent: $from.node(depth - 1) };
}

/** Replaces the captured range in one transaction. False when its text changed since capture. */
export function applyRewrite(editor: Editor, selection: CapturedSelection, output: string) {
	const { state } = editor;
	const range = resolveRange(state, selection);
	if (!range || plainText(state.doc, range.from, range.to) !== selection.text) return false;
	const blocks = parseOutput(editor, output, selection.markdown);
	if (!blocks.length) return false;
	const chain = editor.chain().focus();
	// A lone paragraph goes in as inline content, so replacing part of a sentence doesn't split it.
	if (blocks.length === 1 && blocks[0].type === 'paragraph')
		return chain.insertContentAt(range, blocks[0].content ?? []).run();
	const whole = wholeBlocks(state.doc, range.from, range.to);
	if (!whole) return chain.insertContentAt(range, blocks).run();
	// Rewriting some items of a list: a returned list contributes its items, not a nested list.
	const merge = blocks.length === 1 && blocks[0].type === whole.parent.type.name;
	const content = merge ? (blocks[0].content ?? []) : blocks;
	return chain.insertContentAt({ from: whole.from, to: whole.to }, content).run();
}
