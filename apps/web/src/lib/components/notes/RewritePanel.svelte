<script lang="ts">
	import type { Editor } from '@tiptap/core';
	import { LoaderCircle, Sparkles, X } from '@lucide/svelte';
	import { toast } from '#lib/stores/toast.svelte.js';
	import { startRewrite } from './rewrite.js';
	import {
		buildRewriteMessages,
		cleanRewriteOutput,
		maxNewTokens,
		type RewriteAction
	} from './rewrite-prompts.js';
	import {
		applyRewrite,
		captureSelection,
		rewritePreviewHtml,
		setRewriteTarget,
		type CapturedSelection
	} from './rewrite-editor.js';

	let {
		editor,
		blocked,
		onclose,
		onlayout
	}: {
		editor: Editor;
		/** Why the current selection can't be rewritten, if so */
		blocked: string | null;
		onclose: () => void;
		/** The panel changed size, so the bubble needs repositioning */
		onlayout: () => void;
	} = $props();

	type Phase = 'menu' | 'custom' | 'working' | 'done' | 'conflict';

	const ACTIONS: { action: Exclude<RewriteAction, 'custom'>; label: string }[] = [
		{ action: 'improve', label: 'Improve writing' },
		{ action: 'clarify', label: 'Clarify' },
		{ action: 'grammar', label: 'Fix grammar' }
	];

	let root: HTMLDivElement;
	let phase = $state<Phase>('menu');
	let instruction = $state('');
	let output = $state('');
	let progress = $state<number | null>(null);
	let captured = $state.raw<CapturedSelection | null>(null);
	let run: { cancel: () => void } | null = null;
	const previewHtml = $derived(
		output && captured ? rewritePreviewHtml(editor, output, captured.markdown) : null
	);

	$effect(() => {
		const observer = new ResizeObserver(() => onlayout());
		observer.observe(root);
		return () => {
			observer.disconnect();
			run?.cancel();
			if (captured) setRewriteTarget(editor, null);
		};
	});

	/** Takes the selection and pins it, because moving focus to the panel must not lose it. */
	function capture() {
		captured = captureSelection(editor);
		if (captured) setRewriteTarget(editor, captured);
		else onclose();
		return captured;
	}

	function openCustom() {
		if (capture()) phase = 'custom';
	}

	function choose(action: RewriteAction, text = '') {
		const target = captured ?? capture();
		if (!target) return;
		const source = target.markdown;
		output = '';
		progress = null;
		phase = 'working';
		run = startRewrite(buildRewriteMessages(action, source, text), maxNewTokens(source.length), {
			onprogress: (f) => (progress = f),
			ontoken: (t) => {
				progress = null;
				output += t;
			},
			ondone: () => {
				output = cleanRewriteOutput(output, source);
				if (output) phase = 'done';
				else {
					toast('The model returned no text', { tone: 'error' });
					onclose();
				}
			},
			onerror: (message) => {
				toast('Rewrite failed', { tone: 'error', body: message });
				onclose();
			}
		});
	}

	function replace() {
		if (captured && applyRewrite(editor, captured, output)) onclose();
		else phase = 'conflict';
	}

	async function copy() {
		try {
			await navigator.clipboard.writeText(output);
			toast('Copied', { tone: 'success' });
		} catch {
			toast('Could not copy', { tone: 'error' });
		}
	}

	const keepSelection = (e: MouseEvent) => e.preventDefault();
</script>

{#snippet preview()}
	{#if previewHtml === null}
		<p class="max-h-48 overflow-y-auto rounded-md bg-canvas p-2 whitespace-pre-wrap">{output}</p>
	{:else}
		<div
			class="prose prose-sm max-h-48 max-w-none overflow-y-auto rounded-md bg-canvas p-2 dark:prose-invert"
		>
			<!-- eslint-disable-next-line svelte/no-at-html-tags -- built by the editor's own schema serializer -->
			{@html previewHtml}
		</div>
	{/if}
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	bind:this={root}
	class="w-80 max-w-[calc(100vw-2rem)] p-1 text-sm"
	onkeydown={(e) => {
		if (e.key !== 'Escape') return;
		e.stopPropagation();
		onclose();
	}}
>
	<div class="mb-1 flex items-center gap-1.5 px-1 text-xs font-medium text-muted">
		<Sparkles class="size-3.5" />
		<span class="flex-1">Rewrite on this device</span>
		<button
			class="flex size-6 items-center justify-center rounded-md hover:bg-canvas"
			aria-label="Close"
			onmousedown={keepSelection}
			onclick={onclose}
		>
			<X class="size-3.5" />
		</button>
	</div>

	{#if phase === 'menu'}
		{#if blocked}
			<p class="px-1 py-1 text-xs text-muted">{blocked}</p>
		{:else}
			{#each ACTIONS as a (a.action)}
				<button
					class="block w-full rounded-md px-2 py-1.5 text-left hover:bg-canvas"
					onmousedown={keepSelection}
					onclick={() => choose(a.action)}
				>
					{a.label}
				</button>
			{/each}
			<button
				class="block w-full rounded-md px-2 py-1.5 text-left hover:bg-canvas"
				onmousedown={keepSelection}
				onclick={openCustom}
			>
				Custom instruction…
			</button>
		{/if}
	{:else if phase === 'custom'}
		<form
			class="flex gap-1"
			onsubmit={(e) => {
				e.preventDefault();
				if (instruction.trim()) choose('custom', instruction);
			}}
		>
			<!-- svelte-ignore a11y_autofocus -->
			<input
				class="input h-8 flex-1 text-sm"
				placeholder="e.g. Make it shorter"
				maxlength="300"
				autofocus
				bind:value={instruction}
			/>
			<button class="btn-primary h-8 px-3" disabled={!instruction.trim()}>Go</button>
		</form>
	{:else if phase === 'working'}
		{#if output}
			{@render preview()}
		{:else}
			<p class="flex items-center gap-1.5 px-1 py-1 text-xs text-muted">
				<LoaderCircle class="size-3.5 animate-spin" />
				{progress !== null && progress < 1
					? `Downloading model ${Math.round(progress * 100)}%`
					: 'Loading…'}
			</p>
		{/if}
		<div class="mt-1 flex justify-end">
			<button class="btn-outline h-8 px-3" onmousedown={keepSelection} onclick={onclose}>
				Cancel
			</button>
		</div>
	{:else}
		{@render preview()}
		{#if phase === 'conflict'}
			<p class="mt-1 px-1 text-xs text-red-600">
				Text changed while rewriting, so it wasn't replaced.
			</p>
		{/if}
		<div class="mt-1 flex justify-end gap-1">
			<button class="btn-outline h-8 px-3" onmousedown={keepSelection} onclick={onclose}>
				Discard
			</button>
			{#if phase === 'conflict'}
				<button class="btn-primary h-8 px-3" onmousedown={keepSelection} onclick={copy}>Copy</button
				>
			{:else}
				<button class="btn-primary h-8 px-3" onmousedown={keepSelection} onclick={replace}>
					Replace
				</button>
			{/if}
		</div>
	{/if}
</div>
