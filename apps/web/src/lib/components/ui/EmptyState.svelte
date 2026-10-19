<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		body,
		icon,
		action
	}: { title: string; body?: string; icon?: Snippet; action?: Snippet } = $props();
</script>

<div class="flex flex-col items-center justify-center px-6 py-10 text-center">
	{#if icon}
		<div
			class="mb-3 flex size-11 items-center justify-center rounded-xl bg-primary-50 text-primary-500"
		>
			{@render icon()}
		</div>
	{/if}
	<p class="text-sm font-semibold text-ink">{title}</p>
	{#if body}<p class="mt-1 max-w-sm text-xs text-muted">{body}</p>{/if}
	{#if action}<div class="mt-4">{@render action()}</div>{/if}
</div>
