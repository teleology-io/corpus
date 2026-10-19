<script lang="ts">
	import './layout.css';
	import { onMount } from 'svelte';
	import Toaster from '#lib/components/ui/Toaster.svelte';
	import { theme } from '#lib/stores/theme.svelte.js';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	onMount(() => theme.init());
</script>

<svelte:head>
	<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
	<title>Corpus</title>
</svelte:head>

{@render children()}
<Toaster />
