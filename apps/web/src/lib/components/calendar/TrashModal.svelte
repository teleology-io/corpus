<script lang="ts">
	import { Trash2, RotateCcw, Repeat } from '@lucide/svelte';
	import Modal from '../ui/Modal.svelte';
	import EmptyState from '../ui/EmptyState.svelte';
	import { api } from '#lib/api.js';
	import { attempt } from '#lib/stores/toast.svelte.js';
	import { formatTime, localDate, formatDay } from '#lib/calendar.js';

	interface TrashItem {
		id: string;
		title: string;
		color: string;
		startsAt: string;
		endsAt: string;
		rrule: string | null;
		deletedAt: string;
	}

	let {
		open = $bindable(false),
		tz,
		onchange
	}: { open?: boolean; tz: string; onchange: () => void } = $props();
	let items = $state<TrashItem[]>([]);
	let loading = $state(false);

	$effect(() => {
		if (open) void load();
	});

	async function load() {
		loading = true;
		items = (await attempt(() => api<TrashItem[]>('/api/trash'))) ?? [];
		loading = false;
	}

	async function restore(id: string) {
		await attempt(() => api(`/api/events/${id}/restore`, { method: 'POST' }));
		items = items.filter((i) => i.id !== id);
		onchange();
	}

	async function purge(id: string) {
		await attempt(() => api(`/api/events/${id}?purge=1`, { method: 'DELETE' }));
		items = items.filter((i) => i.id !== id);
	}
</script>

<Modal
	bind:open
	title="Deleted Schedule"
	description="Restore schedules or delete them permanently"
	size="lg"
>
	{#snippet icon()}<Trash2 class="size-5" />{/snippet}
	{#if loading && !items.length}
		<p class="py-8 text-center text-sm text-muted">Loading…</p>
	{:else if !items.length}
		<EmptyState
			title="Nothing in the trash"
			body="Deleted schedules show up here so you can restore them."
		>
			{#snippet icon()}<Trash2 class="size-5" />{/snippet}
		</EmptyState>
	{:else}
		<ul class="divide-y divide-line">
			{#each items as item (item.id)}
				<li class="flex items-center gap-3 py-3">
					<span class="size-2.5 shrink-0 rounded-full" style:background={item.color}></span>
					<div class="min-w-0 flex-1">
						<p class="flex items-center gap-1.5 truncate text-sm font-medium">
							{item.title}{#if item.rrule}<Repeat class="size-3 text-muted" />{/if}
						</p>
						<p class="text-xs text-muted">
							{formatDay(localDate(new Date(item.startsAt), tz))} · {formatTime(item.startsAt, tz)}
						</p>
					</div>
					<button class="btn-outline h-8 text-xs" onclick={() => restore(item.id)}
						><RotateCcw class="size-3.5" /> Restore</button
					>
					<button
						class="btn-icon size-8 hover:text-red-600"
						aria-label="Delete forever"
						onclick={() => purge(item.id)}><Trash2 class="size-4" /></button
					>
				</li>
			{/each}
		</ul>
	{/if}
</Modal>
