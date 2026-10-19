<script lang="ts">
	import { onMount } from 'svelte';
	import { Editor } from '@tiptap/core';
	import StarterKit from '@tiptap/starter-kit';
	import { Placeholder } from '@tiptap/extensions';
	import { TaskList, TaskItem } from '@tiptap/extension-list';
	import { TableKit } from '@tiptap/extension-table';
	import Image from '@tiptap/extension-image';
	import Mention from '@tiptap/extension-mention';
	import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
	import BubbleMenu from '@tiptap/extension-bubble-menu';
	import DragHandle from '@tiptap/extension-drag-handle';
	import Collaboration from '@tiptap/extension-collaboration';
	import CollaborationCaret from '@tiptap/extension-collaboration-caret';
	import { HocuspocusProvider } from '@hocuspocus/provider';
	import * as Y from 'yjs';
	import { common, createLowlight } from 'lowlight';
	import {
		Bold,
		Italic,
		Strikethrough,
		Code,
		Link as LinkIcon,
		Underline,
		Heading2,
		Highlighter,
		Mic,
		LoaderCircle
	} from '@lucide/svelte';
	import { Callout, SlashCommand, menuRenderer } from './extensions.svelte.js';
	import {
		Dictation,
		DictationPreview,
		insertTranscript,
		setPartial,
		type DictationStatus
	} from './dictation.js';
	import type { MenuItem } from './SuggestionMenu.svelte';
	import { toast } from '#lib/stores/toast.svelte.js';

	interface Member {
		id: string;
		name: string;
		image: string | null;
	}

	let {
		noteId,
		collabUrl,
		token,
		user,
		members = [],
		editable = true,
		onstatus
	}: {
		noteId: string;
		collabUrl: string;
		/** Returns a signed collab token for this note */
		token: () => Promise<string>;
		user: { name: string; color: string };
		members?: Member[];
		editable?: boolean;
		onstatus?: (s: {
			connected: boolean;
			synced: boolean;
			peers: { name: string; color: string }[];
		}) => void;
	} = $props();

	let host: HTMLDivElement;
	let bubble: HTMLDivElement;
	let fileInput: HTMLInputElement;
	let editor = $state<Editor | null>(null);
	// Bump to re-render toolbar active states on selection changes.
	let tick = $state(0);
	let dictation: Dictation | null = null;
	let dictStatus = $state<DictationStatus>('idle');
	let dictLevel = $state(0);
	const dictating = $derived(dictStatus !== 'idle');
	const hasSelection = $derived((void tick, editor ? !editor.state.selection.empty : false));

	function toggleDictation() {
		if (dictation) return void dictation.stop();
		const ed = editor;
		if (!ed) return;
		dictation = new Dictation({
			onstatus: (s) => {
				dictStatus = s;
				if (s === 'idle') dictation = null;
				// The bubble doubles as the dictation control, so keep it up (at the caret) while live.
				if (!ed.isDestroyed)
					ed.view.dispatch(
						ed.state.tr.setMeta(
							'bubbleMenu',
							s !== 'idle' || !ed.state.selection.empty ? 'show' : 'hide'
						)
					);
			},
			onpartial: (t) => setPartial(ed, t),
			onresult: (t) => insertTranscript(ed, t),
			onlevel: (l) => (dictLevel = l),
			onerror: (message) => toast('Dictation failed', { tone: 'error', body: message })
		});
		ed.commands.focus();
		void dictation.start();
	}

	async function upload(file: File) {
		const form = new FormData();
		form.append('file', file);
		const res = await fetch('/api/uploads', { method: 'POST', body: form });
		if (!res.ok) {
			toast('Upload failed', { tone: 'error', body: (await res.json().catch(() => ({}))).message });
			return null;
		}
		return ((await res.json()) as { url: string }).url;
	}

	async function insertFiles(files: File[], pos?: number) {
		for (const f of files.filter((f) => f.type.startsWith('image/'))) {
			const src = await upload(f);
			if (src && editor) {
				const chain = editor.chain().focus();
				if (pos !== undefined) chain.insertContentAt(pos, { type: 'image', attrs: { src } }).run();
				else chain.setImage({ src }).run();
			}
		}
	}

	onMount(() => {
		const ydoc = new Y.Doc();
		const provider = new HocuspocusProvider({
			url: collabUrl,
			name: `note:${noteId}`,
			document: ydoc,
			token
		});

		const peers = () =>
			[...provider.awareness!.getStates().values()]
				.map((s) => s.user as { name: string; color: string } | undefined)
				.filter((u): u is { name: string; color: string } => !!u);
		let connected = false;
		let synced = false;
		const report = () => onstatus?.({ connected, synced, peers: peers() });
		provider.on(
			'status',
			({ status }: { status: string }) => ((connected = status === 'connected'), report())
		);
		provider.on('synced', () => ((synced = true), report()));
		provider.on('authenticationFailed', () =>
			toast('You no longer have access to this note', { tone: 'error' })
		);
		provider.awareness?.on('change', report);

		const dragEl = document.createElement('div');
		dragEl.className = 'drag-handle';
		dragEl.innerHTML =
			'<svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor"><circle cx="3" cy="3" r="1.3"/><circle cx="9" cy="3" r="1.3"/><circle cx="3" cy="7" r="1.3"/><circle cx="9" cy="7" r="1.3"/><circle cx="3" cy="11" r="1.3"/><circle cx="9" cy="11" r="1.3"/></svg>';

		editor = new Editor({
			element: host,
			editable,
			extensions: [
				StarterKit.configure({
					undoRedo: false,
					codeBlock: false,
					link: { openOnClick: !editable, autolink: true }
				}),
				Placeholder.configure({
					placeholder: ({ node }) =>
						node.type.name === 'heading' ? 'Heading' : "Type '/' for commands, '@' to mention"
				}),
				TaskList,
				TaskItem.configure({ nested: true }),
				TableKit.configure({ table: { resizable: true } }),
				Image.configure({ HTMLAttributes: { class: 'rounded-lg' } }),
				CodeBlockLowlight.configure({ lowlight: createLowlight(common) }),
				Callout,
				Mention.configure({
					HTMLAttributes: { class: 'mention' },
					suggestion: {
						char: '@',
						items: ({ query }) =>
							members
								.filter((m) => m.name.toLowerCase().includes(query.toLowerCase()))
								.slice(0, 8)
								.map((m) => ({ id: m.id, label: m.name, title: m.name, image: m.image })),
						command: ({ editor, range, props }) =>
							editor
								.chain()
								.focus()
								.insertContentAt(range, [
									{ type: 'mention', attrs: { id: props.id, label: props.label } },
									{ type: 'text', text: ' ' }
								])
								.run(),
						render: menuRenderer<MenuItem & { label: string }>('mention') as never
					}
				}),
				SlashCommand({ onImage: () => fileInput.click(), onDictate: toggleDictation }),
				DictationPreview,
				BubbleMenu.configure({
					element: bubble,
					// Starts invisible (see markup); the plugin toggles visibility and positions it.
					shouldShow: ({ editor, view, state, from, to }) =>
						editor.isEditable &&
						(dictating ||
							((view.hasFocus() || bubble.contains(document.activeElement)) &&
								!state.selection.empty &&
								state.doc.textBetween(from, to).trim().length > 0 &&
								!editor.isActive('image') &&
								!editor.isActive('codeBlock')))
				}),
				...(editable ? [DragHandle.configure({ render: () => dragEl })] : []),
				Collaboration.configure({ document: ydoc }),
				CollaborationCaret.configure({ provider, user })
			],
			editorProps: {
				attributes: {
					class:
						'prose prose-sm sm:prose-base dark:prose-invert max-w-none focus:outline-none prose-headings:tracking-tight prose-img:my-3'
				},
				handleKeyDown: (_view, event) => {
					if (!dictation || event.key !== 'Escape') return false;
					void dictation.stop();
					return true;
				},
				handlePaste: (_view, event) => {
					const files = [...(event.clipboardData?.files ?? [])];
					if (!files.some((f) => f.type.startsWith('image/'))) return false;
					void insertFiles(files);
					return true;
				},
				handleDrop: (view, event) => {
					const files = [...(event.dataTransfer?.files ?? [])];
					if (!files.some((f) => f.type.startsWith('image/'))) return false;
					const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
					void insertFiles(files, pos);
					return true;
				}
			},
			onSelectionUpdate: () => tick++,
			onTransaction: () => tick++
		});

		return () => {
			void dictation?.stop();
			editor?.destroy();
			provider.destroy();
			ydoc.destroy();
			editor = null;
		};
	});

	const active = (name: string, attrs?: Record<string, unknown>) => {
		void tick;
		return editor?.isActive(name, attrs) ?? false;
	};

	function setLink() {
		if (!editor) return;
		const prev = editor.getAttributes('link').href as string | undefined;
		const url = prompt('Link URL', prev ?? 'https://');
		if (url === null) return;
		if (!url) editor.chain().focus().unsetLink().run();
		else editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
	}

	const tools = $derived([
		{
			label: 'Bold',
			icon: Bold,
			on: active('bold'),
			run: () => editor?.chain().focus().toggleBold().run()
		},
		{
			label: 'Italic',
			icon: Italic,
			on: active('italic'),
			run: () => editor?.chain().focus().toggleItalic().run()
		},
		{
			label: 'Underline',
			icon: Underline,
			on: active('underline'),
			run: () => editor?.chain().focus().toggleUnderline().run()
		},
		{
			label: 'Strike',
			icon: Strikethrough,
			on: active('strike'),
			run: () => editor?.chain().focus().toggleStrike().run()
		},
		{
			label: 'Code',
			icon: Code,
			on: active('code'),
			run: () => editor?.chain().focus().toggleCode().run()
		},
		{
			label: 'Heading',
			icon: Heading2,
			on: active('heading', { level: 2 }),
			run: () => editor?.chain().focus().toggleHeading({ level: 2 }).run()
		},
		{
			label: 'Quote',
			icon: Highlighter,
			on: active('blockquote'),
			run: () => editor?.chain().focus().toggleBlockquote().run()
		},
		{ label: 'Link', icon: LinkIcon, on: active('link'), run: setLink }
	]);
</script>

<div
	bind:this={bubble}
	class="invisible absolute z-30 flex w-max items-center gap-0.5 rounded-lg border border-line bg-surface p-1 shadow-pop"
>
	{#if !dictating || hasSelection}
		{#each tools as t (t.label)}
			<button
				class="flex size-7 items-center justify-center rounded-md {t.on
					? 'bg-primary-50 text-primary-600'
					: 'text-gray-600 hover:bg-canvas'}"
				title={t.label}
				onmousedown={(e) => e.preventDefault()}
				onclick={t.run}
			>
				<t.icon class="size-3.5" />
			</button>
		{/each}
		<span class="mx-0.5 h-4 w-px bg-line"></span>
	{/if}
	<button
		class="relative flex h-7 items-center gap-1.5 rounded-md px-1.5 {dictating
			? 'bg-red-50 text-red-600'
			: 'text-gray-600 hover:bg-canvas'}"
		title={dictating ? 'Stop dictation (Esc)' : 'Dictate'}
		aria-pressed={dictating}
		disabled={dictStatus === 'stopping'}
		onmousedown={(e) => e.preventDefault()}
		onclick={toggleDictation}
	>
		{#if dictStatus === 'loading' || dictStatus === 'stopping'}
			<LoaderCircle class="size-3.5 animate-spin" />
		{:else}
			<Mic class="size-3.5" />
		{/if}
		{#if dictating}
			<span class="text-[11px] font-medium">
				{dictStatus === 'loading'
					? 'Loading…'
					: dictStatus === 'stopping'
						? 'Finishing…'
						: 'Listening'}
			</span>
			{#if dictStatus === 'listening'}
				<span
					class="size-1.5 rounded-full bg-red-500 transition-transform"
					style:transform="scale({1 + dictLevel * 1.5})"
				></span>
			{/if}
		{/if}
	</button>
</div>

<input
	bind:this={fileInput}
	type="file"
	accept="image/*"
	class="hidden"
	onchange={(e) => {
		const files = [...(e.currentTarget.files ?? [])];
		e.currentTarget.value = '';
		void insertFiles(files);
	}}
/>

<div bind:this={host} class="pl-6"></div>
