import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

const previewKey = new PluginKey<string>('dictationPreview');

/**
 * Shows the in-flight (partial) transcript as a ghost widget at the caret. Only final
 * results are written to the doc, so collaborators never see half-recognized words churn.
 */
export const DictationPreview = Extension.create({
	name: 'dictationPreview',
	addProseMirrorPlugins() {
		return [
			new Plugin<string>({
				key: previewKey,
				state: {
					init: () => '',
					apply: (tr, prev) => tr.getMeta(previewKey) ?? prev
				},
				props: {
					decorations(state) {
						const text = previewKey.getState(state);
						if (!text) return null;
						return DecorationSet.create(state.doc, [
							Decoration.widget(
								state.selection.head,
								() => {
									const el = document.createElement('span');
									el.className = 'dictation-partial';
									el.textContent = text;
									return el;
								},
								{ key: text, side: 1 }
							)
						]);
					}
				}
			})
		];
	}
});

export function setPartial(editor: Editor, text: string) {
	if (editor.isDestroyed) return;
	editor.view.dispatch(editor.state.tr.setMeta(previewKey, text).setMeta('addToHistory', false));
}

/** Inserts a final phrase at the caret with sentence-aware spacing and capitalization. */
export function insertTranscript(editor: Editor, text: string) {
	if (editor.isDestroyed || !text) return;
	const { $head } = editor.state.selection;
	const before = $head.parent.textBetween(0, $head.parentOffset);
	const needsSpace = before.length > 0 && !/\s$/.test(before);
	const sentenceStart = /(^|[.!?])$/.test(before.trimEnd());
	const phrase = sentenceStart ? text[0].toUpperCase() + text.slice(1) : text;
	editor.commands.insertContent((needsSpace ? ' ' : '') + phrase);
}
