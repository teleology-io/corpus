<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	import { ChevronRight, Plus, Search, Users, Archive, RotateCcw, FileText } from '@lucide/svelte';
	import { api } from '#lib/api.js';
	import { attempt } from '#lib/stores/toast.svelte.js';
	import type { NoteTreeItem } from '#lib/types.js';

	let {
		tree,
		shared,
		archived
	}: {
		tree: NoteTreeItem[];
		shared: NoteTreeItem[];
		archived: { id: string; title: string; icon: string | null }[];
	} = $props();

	let expanded = $state<Record<string, boolean>>({});
	let query = $state('');
	let results = $state<
		{ id: string; title: string; icon: string | null; snippet: string }[] | null
	>(null);
	let showArchived = $state(false);
	let dragId = $state<string | null>(null);
	let dropTarget = $state<{ id: string | null; mode: 'inside' | 'before' } | null>(null);

	const children = (parentId: string | null) => tree.filter((n) => n.parentId === parentId);
	const activeId = $derived(page.params.id);

	// Expand ancestors of the open note.
	$effect(() => {
		let cur = tree.find((n) => n.id === activeId);
		while (cur?.parentId) {
			expanded[cur.parentId] = true;
			cur = tree.find((n) => n.id === cur!.parentId);
		}
	});

	async function create(parentId: string | null = null) {
		const res = await attempt(() => api<{ id: string }>('/api/notes', { body: { parentId } }));
		if (!res) return;
		if (parentId) expanded[parentId] = true;
		await invalidate('app:notes-tree');
		await goto(`/notes/${res.id}`);
	}

	let searchTimer: ReturnType<typeof setTimeout>;
	function onSearch() {
		clearTimeout(searchTimer);
		const q = query.trim();
		if (!q) return (results = null);
		searchTimer = setTimeout(async () => {
			results =
				(await attempt(() =>
					api<NonNullable<typeof results>>(`/api/notes/search?q=${encodeURIComponent(q)}`)
				)) ?? [];
		}, 200);
	}

	async function drop(target: { id: string | null; mode: 'inside' | 'before' }) {
		const id = dragId;
		dragId = null;
		dropTarget = null;
		if (!id || id === target.id) return;
		let body: { parentId: string | null; position: number };
		if (target.mode === 'inside' || target.id === null) {
			body = { parentId: target.id, position: children(target.id).length };
		} else {
			const t = tree.find((n) => n.id === target.id)!;
			body = { parentId: t.parentId, position: t.position };
		}
		await attempt(() => api(`/api/notes/${id}`, { method: 'PATCH', body }), 'Could not move page');
		if (body.parentId) expanded[body.parentId] = true;
		await invalidate('app:notes-tree');
	}

	async function restore(id: string) {
		await attempt(() => api(`/api/notes/${id}`, { method: 'PATCH', body: { archived: false } }));
		await invalidate('app:notes-tree');
	}
</script>

{#snippet node(n: NoteTreeItem, depth: number)}
	{@const kids = children(n.id)}
	{@const on = n.id === activeId}
	<li>
		<div
			role="treeitem"
			aria-selected={on}
			tabindex="-1"
			draggable="true"
			ondragstart={() => (dragId = n.id)}
			ondragend={() => ((dragId = null), (dropTarget = null))}
			ondragover={(e) => {
				e.preventDefault();
				const r = e.currentTarget.getBoundingClientRect();
				dropTarget = { id: n.id, mode: e.clientY - r.top < r.height * 0.3 ? 'before' : 'inside' };
			}}
			ondrop={(e) => (e.preventDefault(), dropTarget && drop(dropTarget))}
			class="group relative flex items-center gap-1 rounded-md py-1 pr-1 text-[13px] {on
				? 'bg-primary-50 text-primary-700'
				: 'text-gray-700 hover:bg-canvas'} {dropTarget?.id === n.id && dropTarget.mode === 'inside'
				? 'ring-2 ring-primary-300'
				: ''}"
			style:padding-left="{depth * 14 + 4}px"
		>
			{#if dropTarget?.id === n.id && dropTarget.mode === 'before'}<span
					class="absolute inset-x-0 -top-px h-0.5 bg-primary-500"
				></span>{/if}
			<button
				class="flex size-5 shrink-0 items-center justify-center rounded text-gray-400 hover:bg-gray-200 {kids.length
					? ''
					: 'invisible'}"
				aria-label="Toggle"
				onclick={() => (expanded[n.id] = !expanded[n.id])}
			>
				<ChevronRight class="size-3.5 transition-transform {expanded[n.id] ? 'rotate-90' : ''}" />
			</button>
			<a href="/notes/{n.id}" class="flex min-w-0 flex-1 items-center gap-1.5">
				<span class="shrink-0 text-sm leading-none">{n.icon ?? '📄'}</span>
				<span class="truncate">{n.title || 'Untitled'}</span>
			</a>
			<button
				class="flex size-5 items-center justify-center rounded text-gray-400 opacity-0 group-hover:opacity-100 hover:bg-gray-200"
				aria-label="Add subpage"
				onclick={() => create(n.id)}
			>
				<Plus class="size-3.5" />
			</button>
		</div>
		{#if expanded[n.id] && kids.length}
			<ul>
				{#each kids as k (k.id)}{@render node(k, depth + 1)}{/each}
			</ul>
		{/if}
	</li>
{/snippet}

<div class="flex h-full flex-col">
	<div class="space-y-2 p-3">
		<div class="relative">
			<Search
				class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted"
			/>
			<input
				class="input h-8 pl-8 text-[13px]"
				placeholder="Search pages"
				bind:value={query}
				oninput={onSearch}
			/>
		</div>
		<button class="btn-ghost h-8 w-full justify-start px-2 text-[13px]" onclick={() => create(null)}
			><Plus class="size-4" /> New page</button
		>
	</div>

	<div class="flex-1 scrollbar-thin overflow-y-auto px-2 pb-4">
		{#if results}
			<p class="mb-1 section-label px-2">Results</p>
			<ul class="space-y-0.5">
				{#each results as r (r.id)}
					<li>
						<a href="/notes/{r.id}" class="block rounded-md px-2 py-1.5 hover:bg-canvas">
							<span class="block truncate text-[13px] font-medium"
								>{r.icon ?? '📄'} {r.title || 'Untitled'}</span
							>
							<span class="block truncate text-[11px] text-muted">{r.snippet}</span>
						</a>
					</li>
				{:else}
					<li class="px-2 py-2 text-xs text-muted">No matches</li>
				{/each}
			</ul>
		{:else}
			<p class="mb-1 section-label px-2">Pages</p>
			<ul
				role="tree"
				ondragover={(e) => e.preventDefault()}
				ondrop={(e) => {
					if (e.target === e.currentTarget) drop({ id: null, mode: 'inside' });
				}}
				class="min-h-8"
			>
				{#each children(null) as n (n.id)}{@render node(n, 0)}{/each}
				{#if !tree.length}<li class="px-2 py-2 text-xs text-muted">No pages yet</li>{/if}
			</ul>

			{#if shared.length}
				<p class="mt-5 mb-1 flex items-center gap-1 section-label px-2">
					<Users class="size-3" /> Shared with me
				</p>
				<ul>
					{#each shared as n (n.id)}
						<li>
							<a
								href="/notes/{n.id}"
								class="flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] {n.id === activeId
									? 'bg-primary-50 text-primary-700'
									: 'text-gray-700 hover:bg-canvas'}"
							>
								<span>{n.icon ?? '📄'}</span><span class="truncate">{n.title || 'Untitled'}</span>
							</a>
						</li>
					{/each}
				</ul>
			{/if}

			{#if archived.length}
				<button
					class="mt-5 mb-1 flex items-center gap-1 section-label px-2 hover:text-ink"
					onclick={() => (showArchived = !showArchived)}
				>
					<Archive class="size-3" /> Archive ({archived.length})
				</button>
				{#if showArchived}
					<ul>
						{#each archived as n (n.id)}
							<li
								class="group flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-muted hover:bg-canvas"
							>
								<FileText class="size-3.5" /><span class="flex-1 truncate"
									>{n.title || 'Untitled'}</span
								>
								<button
									class="opacity-0 group-hover:opacity-100 hover:text-ink"
									aria-label="Restore"
									onclick={() => restore(n.id)}><RotateCcw class="size-3.5" /></button
								>
							</li>
						{/each}
					</ul>
				{/if}
			{/if}
		{/if}
	</div>
</div>
