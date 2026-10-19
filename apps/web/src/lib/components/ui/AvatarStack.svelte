<script lang="ts">
	import type { Person } from '#lib/types.js';
	import Avatar from './Avatar.svelte';

	let { people, max = 3, size = 22 }: { people: Person[]; max?: number; size?: number } = $props();
	const shown = $derived(people.slice(0, max));
	const extra = $derived(people.length - shown.length);
</script>

{#if people.length}
	<div class="flex items-center">
		<div class="flex -space-x-1.5">
			{#each shown as p, i (p.id ?? p.email ?? i)}
				<Avatar name={p.name} image={p.image} {size} />
			{/each}
		</div>
		{#if extra > 0}
			<span
				class="ml-1 inline-flex items-center justify-center rounded-full bg-surface px-1.5 text-[10px] font-semibold text-muted ring-1 ring-line"
				style:height="{size}px">{extra}+</span
			>
		{/if}
	</div>
{/if}
