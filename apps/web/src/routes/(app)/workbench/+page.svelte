<script lang="ts">
	import { onMount } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { SquareTerminal } from '@lucide/svelte';
	import EmptyState from '#lib/components/ui/EmptyState.svelte';
	import { mountWrx } from '#lib/wrx/app.js';
	import '#lib/wrx/wrx.css';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let root = $state<HTMLDivElement>();

	let wrx: ReturnType<typeof mountWrx> | undefined;

	onMount(() => {
		if (!root) return;
		wrx = mountWrx(root);
		return wrx;
	});

	// Same-page navigations (⌘K results, dashboard links) don't remount; hand the new query over.
	afterNavigate((nav) => {
		if (nav.type !== 'enter' && nav.from?.route.id === nav.to?.route.id)
			wrx?.navigate(page.url.searchParams);
	});
</script>

{#if data.enabled}
	<div class="wrx" bind:this={root}></div>
{:else}
	<div class="p-8">
		<EmptyState
			title="Workbench is off for this account"
			body="Workbench runs Git, Claude Code, Codex and Colima on the server as its OS user. Add your email to WRX_ALLOWED_EMAILS to enable it."
		>
			{#snippet icon()}<SquareTerminal class="size-5" />{/snippet}
		</EmptyState>
	</div>
{/if}
