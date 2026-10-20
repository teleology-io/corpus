import type { Editor } from '@tiptap/core';

// Block or inline syntax that plain prose rarely contains by accident.
const MARKDOWN = [
	/^#{1,6}\s+\S/m, // heading
	/^\s*[-*+]\s+\[[ xX]\]\s/m, // task item
	/^\s*([-*+]|\d+[.)])\s+\S/m, // list item
	/^>\s?\S/m, // blockquote
	/^(```|~~~)/m, // code fence
	/^\s*([-*_])(\s*\1){2,}\s*$/m, // horizontal rule
	/^\|.+\|\s*\n\|?\s*:?-{3,}/m, // table header + divider
	/\*\*[^*\n]+\*\*|__[^_\n]+__/, // bold
	/\[[^\]\n]+\]\([^)\s]+\)/, // link
	/`[^`\n]+`/ // inline code
];

// Real formatting from a rich source (web page, Google Docs, another note). Code editors like
// VS Code put styled <div>/<span> soup on the clipboard instead, which we treat as plain text.
const RICH_HTML = /<(h[1-6]|p|ul|ol|li|table|strong|b|em|i|a|blockquote|pre|code)[\s>]/i;

/**
 * Markdown to convert for this paste, or null to let the editor paste normally. Only plain-text
 * pastes that look like Markdown qualify; rich HTML, images and code blocks are left alone.
 */
export function markdownFromPaste(editor: Editor, data: DataTransfer | null): string | null {
	if (!data || editor.isActive('codeBlock')) return null;
	const text = data.getData('text/plain');
	if (!text.trim()) return null;
	const html = data.getData('text/html');
	if (html && RICH_HTML.test(html)) return null;
	return MARKDOWN.some((re) => re.test(text)) ? text : null;
}
