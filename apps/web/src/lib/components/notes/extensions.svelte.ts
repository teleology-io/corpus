import { Extension, Node, mergeAttributes, type Editor, type Range } from '@tiptap/core';
import Suggestion, { type SuggestionOptions, type SuggestionProps } from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { mount, unmount } from 'svelte';
import {
	Heading1,
	Heading2,
	Heading3,
	List,
	ListOrdered,
	ListChecks,
	Quote,
	Code,
	Table,
	Image,
	Minus,
	Lightbulb,
	Mic,
	Type
} from '@lucide/svelte';
import SuggestionMenu, { type MenuItem } from './SuggestionMenu.svelte';

/** Highlighted callout block (Notion-style). */
export const Callout = Node.create({
	name: 'callout',
	group: 'block',
	content: 'paragraph+',
	defining: true,
	parseHTML: () => [{ tag: 'div[data-type="callout"]' }],
	renderHTML: ({ HTMLAttributes }) => [
		'div',
		mergeAttributes(HTMLAttributes, { 'data-type': 'callout' }),
		0
	],
	addCommands() {
		return {
			toggleCallout:
				() =>
				({ commands }) =>
					commands.toggleWrap(this.name)
		};
	}
});

declare module '@tiptap/core' {
	interface Commands<ReturnType> {
		callout: { toggleCallout: () => ReturnType };
	}
}

/** Mounts SuggestionMenu next to the caret and wires keyboard navigation. */
export function menuRenderer<T extends MenuItem>(
	kind: 'slash' | 'mention'
): SuggestionOptions<T>['render'] {
	return () => {
		let host: HTMLDivElement | null = null;
		let app: ReturnType<typeof mount> | null = null;
		const state = $state({ items: [] as T[], selected: 0 });
		let current: SuggestionProps<T> | null = null;

		const place = (props: SuggestionProps<T>) => {
			const rect = props.clientRect?.();
			if (!rect || !host) return;
			const below = window.innerHeight - rect.bottom > 340;
			host.style.left = `${Math.min(rect.left, window.innerWidth - 272)}px`;
			host.style.top = below ? `${rect.bottom + 6}px` : '';
			host.style.bottom = below ? '' : `${window.innerHeight - rect.top + 6}px`;
		};
		const pick = (i: number) => {
			const item = state.items[i];
			if (item && current) current.command(item);
		};

		return {
			onStart(props) {
				current = props;
				state.items = props.items;
				state.selected = 0;
				host = document.createElement('div');
				host.style.position = 'fixed';
				host.style.zIndex = '60';
				document.body.appendChild(host);
				app = mount(SuggestionMenu, {
					target: host,
					props: {
						get items() {
							return state.items;
						},
						get selected() {
							return state.selected;
						},
						onpick: pick,
						kind
					}
				});
				place(props);
			},
			onUpdate(props) {
				current = props;
				state.items = props.items;
				state.selected = 0;
				place(props);
			},
			onKeyDown({ event }) {
				if (event.key === 'ArrowDown') {
					state.selected = (state.selected + 1) % Math.max(1, state.items.length);
					return true;
				}
				if (event.key === 'ArrowUp') {
					state.selected =
						(state.selected - 1 + state.items.length) % Math.max(1, state.items.length);
					return true;
				}
				if (event.key === 'Enter' || event.key === 'Tab') {
					pick(state.selected);
					return true;
				}
				return event.key === 'Escape';
			},
			onExit() {
				if (app) void unmount(app);
				host?.remove();
				app = null;
				host = null;
				current = null;
			}
		};
	};
}

interface SlashItem extends MenuItem {
	run: (editor: Editor, range: Range) => void;
}

type SlashOpts = { onImage: () => void; onDictate: () => void };

export function slashItems(opts: SlashOpts): SlashItem[] {
	return [
		{
			id: 'p',
			title: 'Text',
			description: 'Plain paragraph',
			icon: Type,
			run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run()
		},
		{
			id: 'h1',
			title: 'Heading 1',
			description: 'Big section heading',
			icon: Heading1,
			run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 1 }).run()
		},
		{
			id: 'h2',
			title: 'Heading 2',
			description: 'Medium heading',
			icon: Heading2,
			run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run()
		},
		{
			id: 'h3',
			title: 'Heading 3',
			description: 'Small heading',
			icon: Heading3,
			run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run()
		},
		{
			id: 'ul',
			title: 'Bulleted list',
			icon: List,
			run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run()
		},
		{
			id: 'ol',
			title: 'Numbered list',
			icon: ListOrdered,
			run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run()
		},
		{
			id: 'todo',
			title: 'To-do list',
			description: 'Track tasks with checkboxes',
			icon: ListChecks,
			run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run()
		},
		{
			id: 'quote',
			title: 'Quote',
			icon: Quote,
			run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run()
		},
		{
			id: 'callout',
			title: 'Callout',
			description: 'Make writing stand out',
			icon: Lightbulb,
			run: (e, r) => e.chain().focus().deleteRange(r).toggleCallout().run()
		},
		{
			id: 'code',
			title: 'Code block',
			icon: Code,
			run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run()
		},
		{
			id: 'table',
			title: 'Table',
			icon: Table,
			run: (e, r) =>
				e
					.chain()
					.focus()
					.deleteRange(r)
					.insertTable({ rows: 3, cols: 3, withHeaderRow: true })
					.run()
		},
		{
			id: 'hr',
			title: 'Divider',
			icon: Minus,
			run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run()
		},
		{
			id: 'image',
			title: 'Image',
			description: 'Upload an image',
			icon: Image,
			run: (e, r) => {
				e.chain().focus().deleteRange(r).run();
				opts.onImage();
			}
		},
		{
			id: 'dictate',
			title: 'Dictate',
			description: 'Speak to type',
			icon: Mic,
			run: (e, r) => {
				e.chain().focus().deleteRange(r).run();
				opts.onDictate();
			}
		}
	];
}

export function SlashCommand(opts: SlashOpts) {
	const all = slashItems(opts);
	return Extension.create({
		name: 'slashCommand',
		addProseMirrorPlugins() {
			return [
				Suggestion<SlashItem>({
					editor: this.editor,
					char: '/',
					pluginKey: new PluginKey('slash'),
					startOfLine: false,
					items: ({ query }) =>
						all.filter((i) => i.title.toLowerCase().includes(query.toLowerCase())),
					command: ({ editor, range, props }) => props.run(editor, range),
					render: menuRenderer<SlashItem>('slash')
				})
			];
		}
	});
}
