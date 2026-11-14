<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		subtitle,
		actions,
		children,
		flush = false
	}: {
		title?: string;
		subtitle?: string;
		actions?: Snippet;
		children: Snippet;
		/** No body padding (tables run edge to edge). */
		flush?: boolean;
	} = $props();
</script>

<section class="min-w-0 rounded-xl border border-line bg-surface shadow-card">
	{#if title}
		<header
			class="flex flex-wrap items-center justify-between gap-3 px-5 pt-5 {flush ? 'pb-4' : ''}"
		>
			<div>
				<h2 class="text-[15px] font-semibold">{title}</h2>
				{#if subtitle}<p class="mt-0.5 text-xs text-muted">{subtitle}</p>{/if}
			</div>
			{@render actions?.()}
		</header>
	{/if}
	<div class={flush ? '' : 'p-5'}>{@render children()}</div>
</section>
