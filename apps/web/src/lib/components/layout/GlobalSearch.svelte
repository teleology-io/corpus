<script lang="ts">
	import { Dialog } from 'bits-ui';
	import { goto } from '$app/navigation';
	import { ArrowUpRight, Search } from '@lucide/svelte';
	import { api } from '#lib/api.js';
	import { search } from '#lib/stores/search.svelte.js';
	import type { SearchResult } from '#lib/types.js';

	const MAX = 60;
	const mac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform);

	let query = $state('');
	let results = $state<SearchResult[]>([]);
	let selected = $state(0);
	let loading = $state(false);
	let error = $state('');
	let list = $state<HTMLDivElement>();
	let timer: ReturnType<typeof setTimeout>;
	let generation = 0;
	// Superseded searches are cancelled so the server stops work on stale keystrokes.
	let inflight: AbortController | null = null;

	// Fresh palette every time it opens.
	$effect(() => {
		if (!search.open) return;
		query = '';
		results = [];
		selected = 0;
		error = '';
	});

	function onInput() {
		clearTimeout(timer);
		inflight?.abort();
		inflight = null;
		const q = query.trim();
		const request = ++generation;
		if (!q) {
			results = [];
			loading = false;
			return;
		}
		loading = true;
		timer = setTimeout(async () => {
			const controller = (inflight = new AbortController());
			try {
				const found = await api<SearchResult[]>(`/api/search?q=${encodeURIComponent(q)}`, {
					signal: controller.signal
				});
				if (request !== generation) return;
				results = found.slice(0, MAX);
				selected = 0;
				error = '';
			} catch (e) {
				if (request === generation && !controller.signal.aborted) error = (e as Error).message;
			} finally {
				if (request === generation) loading = false;
			}
		}, 150);
	}

	function open(r: SearchResult | undefined) {
		if (!r) return;
		search.open = false;
		if (r.external) window.open(r.href, '_blank', 'noopener,noreferrer');
		else void goto(r.href);
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			if (!results.length) return;
			selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
			list?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
		} else if (e.key === 'Enter') {
			e.preventDefault();
			open(results[selected]);
		}
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			search.open = !search.open;
		}
	}}
/>

<Dialog.Root bind:open={search.open}>
	<Dialog.Portal>
		<Dialog.Overlay class="fixed inset-0 z-[60] bg-black/50" />
		<Dialog.Content
			class="fixed top-[12vh] left-1/2 z-[60] flex max-h-[76dvh] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop outline-none"
		>
			<Dialog.Title class="sr-only">Search Corpus</Dialog.Title>
			<div class="flex items-center gap-3 border-b border-line px-4">
				<Search class="size-4 shrink-0 text-muted" />
				<input
					class="h-14 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-gray-400"
					placeholder="Search notes, tasks, events, recordings, workbench…"
					autocomplete="off"
					spellcheck="false"
					role="combobox"
					aria-expanded="true"
					aria-controls="global-search-results"
					aria-activedescendant={results.length ? `global-search-${selected}` : undefined}
					bind:value={query}
					oninput={onInput}
					onkeydown={onKeydown}
				/>
				<kbd class="rounded border border-line px-1.5 text-[10px] text-muted">Esc</kbd>
			</div>

			<div
				id="global-search-results"
				role="listbox"
				aria-label="Search results"
				class="min-h-0 flex-1 scrollbar-thin overflow-y-auto p-2"
				bind:this={list}
			>
				{#if error}
					<p class="px-3 py-6 text-center text-sm text-red-600">{error}</p>
				{:else if !query.trim()}
					<p class="px-3 py-6 text-center text-xs text-muted">
						Pages, notes, tasks, events, cycles, reminders, recordings, GitHub / Linear items, Slack
						threads, people and the Workbench.
					</p>
				{:else if !results.length}
					<p class="px-3 py-6 text-center text-sm text-muted">
						{loading ? 'Searching…' : 'No results found.'}
					</p>
				{:else}
					{#each results as r, i (r.kind + r.href + i)}
						<button
							type="button"
							role="option"
							id="global-search-{i}"
							data-index={i}
							aria-selected={i === selected}
							class="grid w-full grid-cols-[96px_minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg px-3 py-2 text-left {i ===
							selected
								? 'bg-primary-50'
								: 'hover:bg-canvas'}"
							onmousemove={() => (selected = i)}
							onclick={() => open(r)}
						>
							<span
								class="row-span-2 justify-self-start rounded border px-1.5 py-0.5 text-[9px] font-semibold tracking-wide uppercase {i ===
								selected
									? 'border-primary-300 text-primary-700'
									: 'border-line text-muted'}">{r.kind}</span
							>
							<span class="truncate text-[13px] font-medium text-ink">{r.title}</span>
							{#if r.external}<ArrowUpRight class="row-span-2 size-3.5 text-muted" />{:else}<span
									class="row-span-2"
								></span>{/if}
							<span class="truncate text-[11px] text-muted">{r.detail}</span>
						</button>
					{/each}
				{/if}
			</div>

			<p class="border-t border-line px-4 py-2 text-[10px] text-muted">
				{results.length ? `${results.length} results · ` : ''}↑ ↓ to navigate · Enter to open · {mac
					? '⌘'
					: 'Ctrl'} K to toggle
			</p>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
