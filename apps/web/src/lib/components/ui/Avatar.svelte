<script lang="ts">
	let {
		name,
		image = null,
		size = 28,
		class: cls = ''
	}: { name: string; image?: string | null; size?: number; class?: string } = $props();

	const PALETTE = ['#2C87F2', '#E5484D', '#30A46C', '#F5A524', '#8E4EC6', '#0EA5A4', '#E93D82'];
	const initials = $derived(
		name
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((p) => p[0]?.toUpperCase())
			.join('') || '?'
	);
	const bg = $derived(PALETTE[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length]);
</script>

{#if image}
	<img
		src={image}
		alt={name}
		title={name}
		class="shrink-0 rounded-full object-cover ring-2 ring-surface {cls}"
		style:width="{size}px"
		style:height="{size}px"
	/>
{:else}
	<span
		title={name}
		class="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ring-2 ring-surface {cls}"
		style:width="{size}px"
		style:height="{size}px"
		style:background={bg}
		style:font-size="{Math.round(size * 0.4)}px">{initials}</span
	>
{/if}
