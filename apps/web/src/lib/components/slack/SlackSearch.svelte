<script lang="ts">
	import { untrack } from 'svelte';
	import { format } from 'date-fns';
	import { ArrowLeft, FileText, LoaderCircle, Search, SlidersHorizontal, X } from '@lucide/svelte';
	import EmptyState from '#lib/components/ui/EmptyState.svelte';
	import { api } from '#lib/api.js';
	import { buildSlackQuery, parseSlackQuery } from '#lib/slack-query.js';
	import type { SlackSearchResultDTO } from '#lib/types.js';
	import SlackText from './SlackText.svelte';

	let {
		query,
		onquery,
		onopen,
		onclose
	}: {
		query: string;
		onquery: (q: string) => void;
		onopen: (r: SlackSearchResultDTO) => void;
		onclose: () => void;
	} = $props();

	interface SearchRes {
		results: SlackSearchResultDTO[];
		pages: number;
		total: number;
	}

	let results = $state<SlackSearchResultDTO[]>([]);
	let page = $state(1);
	let pages = $state(1);
	let total = $state(0);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let showFilters = $state(false);
	let parts = $state(parseSlackQuery(''));

	$effect(() => {
		const q = query;
		untrack(() => {
			parts = parseSlackQuery(q);
			if (parts.in || parts.from || parts.after || parts.before) showFilters = true;
			void run(q, 1);
		});
	});

	async function run(q: string, p: number) {
		if (!q.trim()) return;
		loading = true;
		error = null;
		try {
			const res = await api<SearchRes>(`/api/slack/search?q=${encodeURIComponent(q)}&page=${p}`);
			if (q !== query) return;
			results = p === 1 ? res.results : [...results, ...res.results];
			page = p;
			pages = res.pages;
			total = res.total;
		} catch (e) {
			error = (e as Error).message;
			if (p === 1) results = [];
		} finally {
			loading = false;
		}
	}

	function apply(e: SubmitEvent) {
		e.preventDefault();
		const q = buildSlackQuery(parts);
		if (q) onquery(q);
	}
</script>

<header class="flex items-center gap-2 border-b border-line px-4 py-3">
	<button class="btn-icon size-8 md:hidden" aria-label="Back" onclick={onclose}
		><ArrowLeft class="size-4" /></button
	>
	<Search class="size-4 shrink-0 text-muted" />
	<div class="min-w-0 flex-1">
		<p class="truncate text-sm font-semibold">Search: {query}</p>
		{#if !loading && !error}<p class="text-xs text-muted">
				{total}
				{total === 1 ? 'result' : 'results'}
			</p>{/if}
	</div>
	<button
		class="btn-icon size-8 {showFilters ? 'bg-primary-50 text-primary-600' : ''}"
		aria-label="Filters"
		title="Filters"
		onclick={() => (showFilters = !showFilters)}><SlidersHorizontal class="size-4" /></button
	>
	<button class="btn-icon hidden size-8 md:inline-flex" aria-label="Close search" onclick={onclose}
		><X class="size-4" /></button
	>
</header>

{#if showFilters}
	<form class="grid gap-2 border-b border-line p-3 text-xs sm:grid-cols-2" onsubmit={apply}>
		<label class="sm:col-span-2"
			><span class="label">Words</span>
			<input class="input h-8 w-full text-sm" bind:value={parts.text} placeholder="release notes" />
		</label>
		<label
			><span class="label">In</span>
			<input
				class="input h-8 w-full text-sm"
				bind:value={parts.in}
				placeholder="#general or @alice"
			/>
		</label>
		<label
			><span class="label">From</span>
			<input class="input h-8 w-full text-sm" bind:value={parts.from} placeholder="@alice" />
		</label>
		<label
			><span class="label">After</span>
			<input type="date" class="input h-8 w-full text-sm" bind:value={parts.after} />
		</label>
		<label
			><span class="label">Before</span>
			<input type="date" class="input h-8 w-full text-sm" bind:value={parts.before} />
		</label>
		<div class="flex justify-end sm:col-span-2">
			<button class="btn-primary h-8 text-xs">Search</button>
		</div>
	</form>
{/if}

<ul class="min-h-0 flex-1 scrollbar-thin divide-y divide-line overflow-y-auto">
	{#if error}
		<li class="p-4">
			<p class="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
		</li>
	{/if}
	{#each results as r, i (`${r.kind}:${r.channelId}:${r.ts}:${i}`)}
		<li>
			<button
				class="flex w-full gap-3 px-4 py-3 text-left hover:bg-canvas/60 disabled:cursor-default"
				disabled={!r.channelId && !r.permalink}
				onclick={() => onopen(r)}
			>
				<span class="min-w-0 flex-1">
					<span class="flex items-center gap-1.5 text-xs text-muted">
						<span class="truncate font-medium text-ink">{r.channelName}</span>
						<span>·</span>
						<span class="truncate">{r.author}</span>
						{#if r.threadTs}<span class="chip bg-canvas py-0 text-[10px]">in thread</span>{/if}
						<span class="ml-auto shrink-0">{format(new Date(r.at), 'PP')}</span>
					</span>
					{#if r.kind === 'file'}
						<span class="mt-1 flex items-center gap-1.5 text-sm"
							><FileText class="size-3.5 text-muted" />{r.fileName}</span
						>
					{:else}
						<span class="mt-0.5 line-clamp-3 block"><SlackText segments={r.segments} /></span>
					{/if}
				</span>
			</button>
		</li>
	{:else}
		{#if !loading && !error}
			<li>
				<EmptyState title="No matches" body="Try fewer words, or check the filters.">
					{#snippet icon()}<Search class="size-5" />{/snippet}
				</EmptyState>
			</li>
		{/if}
	{/each}
	{#if loading}
		<li class="flex items-center gap-2 p-4 text-sm text-muted">
			<LoaderCircle class="size-4 animate-spin" /> Searching Slack…
		</li>
	{:else if page < pages && results.length}
		<li class="flex justify-center p-3">
			<button class="btn-ghost h-8 text-xs" onclick={() => run(query, page + 1)}
				>More results</button
			>
		</li>
	{/if}
</ul>
