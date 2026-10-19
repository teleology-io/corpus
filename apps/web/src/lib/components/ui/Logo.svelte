<script lang="ts">
	let { size = 28, wordmark = true }: { size?: number; wordmark?: boolean } = $props();
</script>

<span class="inline-flex items-center gap-2.5">
	<svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
		<rect width="32" height="32" rx="9" fill="#2C87F2" />
		<path
			d="M21.5 11.2a7 7 0 1 0 0 9.6"
			fill="none"
			stroke="white"
			stroke-width="3.2"
			stroke-linecap="round"
		/>
		<circle cx="22.4" cy="16" r="2.1" fill="white" />
	</svg>
	{#if wordmark}
		<span class="text-[19px] font-bold tracking-tight text-ink">Corpus</span>
	{/if}
</span>
