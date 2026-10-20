<script lang="ts" module>
	export interface MenuItem {
		id: string;
		title: string;
		description?: string;
		icon?: import('svelte').Component<{ class?: string }>;
		image?: string | null;
	}
</script>

<script lang="ts">
	import Avatar from '../ui/Avatar.svelte';

	let {
		items,
		selected,
		onpick,
		kind
	}: {
		items: MenuItem[];
		selected: number;
		onpick: (i: number) => void;
		kind: 'slash' | 'mention';
	} = $props();

	let buttons: HTMLButtonElement[] = $state([]);
	// Keep the keyboard-selected item visible when arrowing past the menu's scroll height.
	$effect(() => buttons[selected]?.scrollIntoView({ block: 'nearest' }));
</script>

<div class="menu max-h-80 w-64 overflow-y-auto">
	{#each items as item, i (item.id)}
		<button
			bind:this={buttons[i]}
			class="menu-item {i === selected ? 'bg-canvas' : ''}"
			onmousedown={(e) => (e.preventDefault(), onpick(i))}
		>
			{#if kind === 'mention'}
				<Avatar name={item.title} image={item.image} size={22} />
			{:else if item.icon}
				<span
					class="flex size-8 shrink-0 items-center justify-center rounded-md border border-line bg-surface"
					><item.icon class="size-4" /></span
				>
			{/if}
			<span class="min-w-0 text-left">
				<span class="block truncate text-sm">{item.title}</span>
				{#if item.description}<span class="block truncate text-[11px] text-muted"
						>{item.description}</span
					>{/if}
			</span>
		</button>
	{:else}
		<p class="px-3 py-2 text-xs text-muted">No results</p>
	{/each}
</div>
