<script lang="ts">
	import { untrack } from 'svelte';
	import { Hash, LoaderCircle, Lock } from '@lucide/svelte';
	import Modal from '#lib/components/ui/Modal.svelte';
	import { api } from '#lib/api.js';

	let {
		open = $bindable(false),
		onpick
	}: {
		open?: boolean;
		onpick: (c: {
			id: string;
			name: string;
			kind: 'public' | 'private' | 'im' | 'mpim';
			topic: string | null;
		}) => void;
	} = $props();

	interface Channel {
		id: string;
		name: string;
		kind: 'public' | 'private' | 'im' | 'mpim';
		isMember: boolean;
		members: number | null;
		topic: string | null;
	}

	let channels = $state<Channel[]>([]);
	let cursor = $state<string | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let filter = $state('');

	$effect(() => {
		if (open)
			untrack(() => {
				channels = [];
				cursor = null;
				filter = '';
				void more();
			});
	});

	async function more() {
		loading = true;
		error = null;
		try {
			const res = await api<{ channels: Channel[]; nextCursor: string | null }>(
				`/api/slack/conversations/browse${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`
			);
			channels = [...channels, ...res.channels];
			cursor = res.nextCursor;
		} catch (e) {
			error = (e as Error).message;
		} finally {
			loading = false;
		}
	}

	const shown = $derived(
		channels
			.filter((c) => !filter.trim() || c.name.toLowerCase().includes(filter.trim().toLowerCase()))
			.sort((a, b) => a.name.localeCompare(b.name))
	);
</script>

<Modal
	bind:open
	title="Browse channels"
	description="Channels you can see in Slack, joined or not."
	size="md"
>
	{#snippet icon()}<Hash class="size-5" />{/snippet}
	<div class="space-y-3">
		<input class="input h-9 w-full text-sm" placeholder="Filter channels" bind:value={filter} />
		{#if error}<p class="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>{/if}
		<ul
			class="max-h-[50dvh] scrollbar-thin divide-y divide-line overflow-y-auto rounded-lg border border-line"
		>
			{#each shown as c (c.id)}
				<li>
					<button
						class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-canvas/60"
						onclick={() => {
							open = false;
							onpick(c);
						}}
					>
						{#if c.kind === 'private'}<Lock class="size-3.5 text-muted" />{:else}<Hash
								class="size-3.5 text-muted"
							/>{/if}
						<span class="min-w-0 flex-1">
							<span class="block truncate font-medium">{c.name}</span>
							{#if c.topic}<span class="block truncate text-xs text-muted">{c.topic}</span>{/if}
						</span>
						{#if c.isMember}<span class="chip bg-emerald-50 text-emerald-700">Joined</span>{/if}
						{#if c.members}<span class="text-xs text-muted">{c.members}</span>{/if}
					</button>
				</li>
			{:else}
				{#if !loading}<li class="p-3 text-sm text-muted">No channels found.</li>{/if}
			{/each}
		</ul>
		{#if loading}
			<p class="flex items-center gap-2 text-sm text-muted">
				<LoaderCircle class="size-4 animate-spin" /> Loading…
			</p>
		{:else if cursor}
			<button class="btn-ghost h-8 w-full text-xs" onclick={more}>Load more</button>
		{/if}
	</div>
</Modal>
