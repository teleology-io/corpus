<script lang="ts">
	import { goto } from '$app/navigation';
	import { formatDistanceToNowStrict } from 'date-fns';
	import { FileText, Plus } from '@lucide/svelte';
	import EmptyState from '#lib/components/ui/EmptyState.svelte';
	import { api } from '#lib/api.js';
	import { attempt } from '#lib/stores/toast.svelte.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const recent = $derived(
		[...data.tree].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 12)
	);

	async function create() {
		const res = await attempt(() => api<{ id: string }>('/api/notes', { body: {} }));
		if (res) await goto(`/notes/${res.id}`);
	}
</script>

<svelte:head><title>My Notes · Corpus</title></svelte:head>

<div class="mx-auto max-w-5xl p-4 lg:p-8">
	<div class="mb-6 flex items-center gap-3">
		<div>
			<h2 class="text-lg font-semibold">Recent pages</h2>
			<p class="text-sm text-muted">
				Write together in real time. Share with your team or by link.
			</p>
		</div>
		<button class="ml-auto btn-primary" onclick={create}><Plus class="size-4" /> New page</button>
	</div>
	{#if recent.length}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each recent as n (n.id)}
				<a
					href="/notes/{n.id}"
					class="group flex flex-col card p-4 transition-shadow hover:shadow-pop"
				>
					<span class="text-2xl">{n.icon ?? '📄'}</span>
					<span class="mt-3 truncate font-semibold group-hover:text-primary-600"
						>{n.title || 'Untitled'}</span
					>
					<span class="mt-1 text-xs text-muted"
						>Edited {formatDistanceToNowStrict(new Date(n.updatedAt), { addSuffix: true })}</span
					>
				</a>
			{/each}
		</div>
	{:else}
		<div class="card">
			<EmptyState
				title="No pages yet"
				body="Create a page — headings, checklists, tables, code, images and @mentions are all supported."
			>
				{#snippet icon()}<FileText class="size-5" />{/snippet}
				{#snippet action()}<button class="btn-primary" onclick={create}
						><Plus class="size-4" /> New page</button
					>{/snippet}
			</EmptyState>
		</div>
	{/if}
</div>
