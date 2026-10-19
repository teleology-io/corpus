<script lang="ts">
	import { Popover } from 'bits-ui';
	import { Bell, CheckCheck } from '@lucide/svelte';
	import { formatDistanceToNowStrict } from 'date-fns';
	import { api } from '#lib/api.js';
	import { live } from '#lib/stores/live.svelte.js';
	import type { NotificationDTO } from '#lib/types.js';

	let open = $state(false);
	let loading = $state(false);

	async function load() {
		loading = true;
		try {
			const data = await api<{ items: NotificationDTO[]; unread: number }>('/api/notifications');
			live.latest = data.items;
			live.unread = data.unread;
		} finally {
			loading = false;
		}
	}

	async function markAll() {
		await api('/api/notifications', { body: {} });
	}

	async function openItem(n: NotificationDTO) {
		if (!n.readAt) await api('/api/notifications', { body: { ids: [n.id] } });
		open = false;
	}
</script>

<Popover.Root bind:open onOpenChange={(o) => o && load()}>
	<Popover.Trigger class="relative btn-icon" aria-label="Notifications">
		<Bell class="size-5" />
		{#if live.unread > 0}
			<span
				class="absolute top-1.5 right-2 size-2.5 rounded-full border-2 border-surface bg-red-500"
			></span>
		{/if}
	</Popover.Trigger>
	<Popover.Portal>
		<Popover.Content class="menu w-96 p-0" align="end" sideOffset={8}>
			<div class="flex items-center justify-between border-b border-line px-4 py-3">
				<p class="text-sm font-semibold">
					Notifications {#if live.unread}<span class="ml-1 chip bg-red-50 text-red-600"
							>{live.unread}</span
						>{/if}
				</p>
				<button
					class="flex items-center gap-1 text-xs font-medium text-primary-600 hover:underline"
					onclick={markAll}
				>
					<CheckCheck class="size-3.5" /> Mark all read
				</button>
			</div>
			<div class="max-h-[420px] scrollbar-thin overflow-y-auto">
				{#if loading && !live.latest.length}
					<p class="p-6 text-center text-xs text-muted">Loading…</p>
				{:else if !live.latest.length}
					<p class="p-8 text-center text-xs text-muted">You're all caught up.</p>
				{:else}
					{#each live.latest as n (n.id)}
						<a
							href={n.href ?? '#'}
							onclick={() => openItem(n)}
							class="flex gap-3 border-b border-line/70 px-4 py-3 last:border-0 hover:bg-canvas"
						>
							<span
								class="mt-1.5 size-2 shrink-0 rounded-full {n.readAt
									? 'bg-transparent'
									: 'bg-primary-500'}"
							></span>
							<span class="min-w-0 flex-1">
								<span
									class="block text-[13px] leading-snug {n.readAt
										? 'text-muted'
										: 'font-medium text-ink'}">{n.title}</span
								>
								{#if n.body}<span class="mt-0.5 block truncate text-xs text-muted">{n.body}</span
									>{/if}
								<span class="mt-1 block text-[11px] text-gray-400"
									>{formatDistanceToNowStrict(new Date(n.createdAt), { addSuffix: true })}</span
								>
							</span>
						</a>
					{/each}
				{/if}
			</div>
			<a
				href="/settings#notifications"
				class="block border-t border-line px-4 py-2.5 text-center text-xs font-medium text-muted hover:text-ink"
				onclick={() => (open = false)}
			>
				Notification settings
			</a>
		</Popover.Content>
	</Popover.Portal>
</Popover.Root>
