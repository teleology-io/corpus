<script lang="ts">
	import type { Snippet } from 'svelte';

	let { title, body, children }: { title: string; body?: string; children?: Snippet } = $props();
</script>

<div class="px-6 py-14 text-center">
	<p class="font-semibold">{title}</p>
	{#if body}<p class="mx-auto mt-1 max-w-md text-sm text-muted">{body}</p>{/if}
	{#if children}<div class="mt-4">{@render children()}</div>{/if}
</div>
