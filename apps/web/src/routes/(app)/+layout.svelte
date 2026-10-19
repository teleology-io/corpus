<script lang="ts">
	import { onMount } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import Sidebar from '#lib/components/layout/Sidebar.svelte';
	import Topbar from '#lib/components/layout/Topbar.svelte';
	import { live } from '#lib/stores/live.svelte.js';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
	let drawer = $state(false);

	onMount(() => {
		live.start(data.unread);
		// Keep the browser timezone in sync for new accounts (defaults to UTC).
		const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (data.user.timezone === 'UTC' && tz && tz !== 'UTC') {
			void fetch('/api/me', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ timezone: tz })
			}).then((r) => r.ok && live.softRefresh());
		}
		return () => live.stop();
	});

	afterNavigate(() => (drawer = false));
</script>

<div class="flex h-dvh overflow-hidden">
	<div class="hidden lg:block">
		<Sidebar />
	</div>

	{#if drawer}
		<div class="fixed inset-0 z-40 lg:hidden">
			<button
				class="absolute inset-0 bg-black/50"
				aria-label="Close menu"
				onclick={() => (drawer = false)}
			></button>
			<div class="relative h-full w-fit shadow-pop">
				<Sidebar onnavigate={() => (drawer = false)} />
			</div>
		</div>
	{/if}

	<div class="flex min-w-0 flex-1 flex-col">
		<Topbar onmenu={() => (drawer = true)} />
		<main class="min-h-0 flex-1 scrollbar-thin overflow-y-auto">
			{@render children()}
		</main>
	</div>
</div>
