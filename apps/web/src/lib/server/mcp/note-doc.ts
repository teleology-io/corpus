import { marked, type Token, type Tokens } from 'marked';
import * as Y from 'yjs';

type Marks = Record<string, Record<string, unknown>>;
type Run = { text: string; marks: Marks };

const decode = (s: string) =>
	s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&');

function inline(tokens: Token[] = [], marks: Marks = {}): Run[] {
	return tokens.flatMap((t): Run[] => {
		switch (t.type) {
			case 'strong':
				return inline(t.tokens, { ...marks, bold: {} });
			case 'em':
				return inline(t.tokens, { ...marks, italic: {} });
			case 'del':
				return inline(t.tokens, { ...marks, strike: {} });
			case 'codespan':
				// The editor's code mark excludes every other mark.
				return [{ text: decode(t.text), marks: { code: {} } }];
			case 'link':
				return inline(
					t.tokens,
					/^(https?:|mailto:|\/(?!\/))/i.test(t.href) ? { ...marks, link: { href: t.href } } : marks
				);
			case 'br':
				return [{ text: ' ', marks }];
			case 'text':
				if (t.tokens) return inline(t.tokens, marks);
		}
		return [{ text: decode('text' in t ? String(t.text) : t.raw), marks }];
	});
}

function block(name: string, children: (Y.XmlElement | Y.XmlText)[], attrs: object = {}) {
	const el = new Y.XmlElement(name);
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v as string);
	el.insert(0, children);
	return el;
}

function text(runs: Run[]) {
	const t = new Y.XmlText();
	let at = 0;
	for (const r of runs) {
		if (!r.text) continue;
		// Explicit attributes: an empty object stops a run inheriting the previous run's marks.
		t.insert(at, r.text, r.marks);
		at += r.text.length;
	}
	return t;
}

const paragraph = (runs: Run[]) => block('paragraph', [text(runs)]);

function list(t: Tokens.List): Y.XmlElement {
	const tasks = t.items.length > 0 && t.items.every((i) => i.task);
	return block(
		tasks ? 'taskList' : t.ordered ? 'orderedList' : 'bulletList',
		t.items.map((i) => {
			const inner = blocks(i.tokens);
			// List items must open with a paragraph.
			if (inner[0]?.nodeName !== 'paragraph') inner.unshift(paragraph([]));
			return tasks ? block('taskItem', inner, { checked: !!i.checked }) : block('listItem', inner);
		}),
		t.ordered && !tasks ? { start: Number(t.start) || 1 } : {}
	);
}

function blocks(tokens: Token[]): Y.XmlElement[] {
	return tokens.flatMap((t): Y.XmlElement[] => {
		switch (t.type) {
			case 'space':
			case 'def':
			case 'checkbox':
				return [];
			case 'heading':
				return [block('heading', [text(inline(t.tokens))], { level: t.depth })];
			case 'list':
				return [list(t as Tokens.List)];
			case 'blockquote': {
				const inner = blocks(t.tokens ?? []);
				return [block('blockquote', inner.length ? inner : [paragraph([])])];
			}
			case 'hr':
				return [block('horizontalRule', [])];
			case 'code':
				return [
					block(
						'codeBlock',
						[text([{ text: t.text, marks: {} }])],
						t.lang ? { language: t.lang } : {}
					)
				];
			case 'paragraph':
			case 'text':
				return [paragraph(t.tokens ? inline(t.tokens) : [{ text: decode(t.text), marks: {} }])];
			case 'table':
				return [block('codeBlock', [text([{ text: t.raw.trim(), marks: {} }])])];
			default:
				return [paragraph([{ text: t.raw.trim(), marks: {} }])];
		}
	});
}

/** Markdown as the note editor's stored Yjs state, plus its plain text for search. */
export function noteDocument(markdown: string) {
	const tokens = marked.lexer(markdown);
	const doc = new Y.Doc();
	const content = blocks(tokens);
	if (content.length) doc.getXmlFragment('default').insert(0, content);
	const lines: string[] = [];
	const walk = (node: Y.XmlElement | Y.XmlText) => {
		if (node instanceof Y.XmlText) {
			lines.push(
				node
					.toDelta()
					.map((d: { insert: unknown }) => String(d.insert))
					.join('')
			);
		} else for (const c of node.toArray()) walk(c as Y.XmlElement | Y.XmlText);
	};
	for (const el of doc.getXmlFragment('default').toArray()) walk(el as Y.XmlElement);
	const ydoc = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	return { ydoc, contentText: lines.filter(Boolean).join('\n').slice(0, 100_000) };
}
