<script lang="ts">
	import { page } from '$app/state';
	import { Popover } from 'bits-ui';
	import { Copy, Link2, Lock, RefreshCw, Share2 } from '@lucide/svelte';
	import Switch from '../ui/Switch.svelte';
	import { api } from '#lib/api.js';
	import { attempt, toast } from '#lib/stores/toast.svelte.js';

	let {
		videoId,
		linkToken = $bindable(null)
	}: {
		videoId: string;
		/** Set while "anyone with the link" is on */
		linkToken?: string | null;
	} = $props();

	let busy = $state(false);
	const url = $derived(linkToken ? `${page.url.origin}/v/${linkToken}` : null);

	async function setLink(on: boolean, reset = false) {
		busy = true;
		if (on) {
			const res = await attempt(() =>
				api<{ linkToken: string }>(`/api/telescope/${videoId}/link`, { body: { reset } })
			);
			if (res) linkToken = res.linkToken;
			if (res && reset)
				toast('New link created', { tone: 'success', body: 'The old link no longer works.' });
		} else {
			try {
				await api(`/api/telescope/${videoId}/link`, { method: 'DELETE' });
				linkToken = null;
			} catch (e) {
				toast('Something went wrong', { tone: 'error', body: (e as Error).message });
			}
		}
		busy = false;
	}

	function copy() {
		if (!url) return;
		void navigator.clipboard.writeText(url);
		toast('Link copied', { tone: 'success' });
	}
</script>

<Popover.Root>
	<Popover.Trigger class="btn-outline h-8 text-xs">
		{#if linkToken}<Share2 class="size-3.5" />{:else}<Lock class="size-3.5" />{/if}
		Share
	</Popover.Trigger>
	<Popover.Portal>
		<Popover.Content class="menu w-80 p-3" sideOffset={6} align="end">
			<div class="flex items-center gap-3">
				<span class="flex size-8 items-center justify-center rounded-lg bg-canvas"
					>{#if linkToken}<Link2 class="size-4" />{:else}<Lock class="size-4" />{/if}</span
				>
				<div class="flex-1">
					<p class="text-sm font-medium">Anyone with the link</p>
					<p class="text-xs text-muted">
						{linkToken ? 'Can watch — no account needed.' : 'Off — only you can watch this.'}
					</p>
				</div>
				<Switch
					checked={!!linkToken}
					label="Anyone with the link"
					disabled={busy}
					onchange={(v) => setLink(v)}
				/>
			</div>
			{#if url}
				<div class="mt-3 flex gap-2">
					<input
						class="input h-9 flex-1 text-xs"
						readonly
						value={url}
						onfocus={(e) => e.currentTarget.select()}
					/>
					<button class="btn-primary h-9" aria-label="Copy link" onclick={copy}
						><Copy class="size-3.5" /></button
					>
				</div>
				<button
					class="mt-2 flex items-center gap-1.5 text-xs text-muted hover:text-ink disabled:opacity-50"
					disabled={busy}
					onclick={() => setLink(true, true)}
					><RefreshCw class="size-3" /> Reset link (old URL stops working)</button
				>
			{/if}
		</Popover.Content>
	</Popover.Portal>
</Popover.Root>
