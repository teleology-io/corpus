<script lang="ts">
	import type { Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { X } from '@lucide/svelte';
	import Toaster from './Toaster.svelte';
	import { layers } from '#lib/toast.svelte.js';

	/**
	 * Detail drawer driven by a URL search param, so details are linkable and survive refresh.
	 * Closing removes the param.
	 */
	let { param, title, children }: { param: string; title: string; children: Snippet } = $props();

	let dialog: HTMLDialogElement | undefined = $state();
	const open = $derived(page.url.searchParams.has(param));

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		if (!open && dialog.open) dialog.close();
	});

	$effect(() => {
		if (!open) return;
		layers.drawers++;
		return () => {
			layers.drawers--;
		};
	});

	function close() {
		const url = new URL(page.url.href);
		url.searchParams.delete(param);
		goto(url, { replace: true, reset: false });
	}
</script>

<dialog
	bind:this={dialog}
	onclose={() => open && close()}
	onclick={(e) => e.target === dialog && close()}
	aria-label={title}
	class="m-0 ml-auto h-dvh max-h-dvh w-[480px] max-w-full bg-surface text-ink shadow-pop backdrop:bg-gray-900/30"
>
	<div class="flex h-full flex-col">
		<header class="flex items-center justify-between border-b border-line px-6 py-4">
			<h2 class="text-base font-semibold">{title}</h2>
			<button
				type="button"
				onclick={close}
				class="rounded-md p-1.5 text-muted hover:bg-gray-100"
				aria-label="Close details"
			>
				<X size={18} />
			</button>
		</header>
		<div class="flex-1 overflow-y-auto px-6 py-5">
			{#if open}{@render children()}{/if}
		</div>
	</div>
	{#if open}<Toaster inDrawer />{/if}
</dialog>
