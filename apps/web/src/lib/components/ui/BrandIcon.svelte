<script lang="ts">
	let { name, class: cls = 'size-4' }: { name: string; class?: string } = $props();
</script>

{#if name === 'github'}
	<svg class={cls} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
		<path
			d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.81 1.18 1.83 1.18 3.09 0 4.42-2.69 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"
		/>
	</svg>
{:else if name === 'linear'}
	<svg class={cls} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
		<path
			d="M1.2 14.6 9.4 22.8A11 11 0 0 1 1.2 14.6ZM.9 11.3l11.8 11.8c1.06-.07 2.07-.29 3.02-.64L1.54 8.28c-.35.95-.57 1.96-.64 3.02Zm1.35-4.73L17.43 21.75c.78-.4 1.5-.88 2.16-1.43L3.68 4.41c-.55.66-1.03 1.38-1.43 2.16Zm2.94-3.86A11 11 0 1 1 21.3 18.81L5.19 2.71Z"
		/>
	</svg>
{:else if name === 'google-calendar'}
	<svg
		class={cls}
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		aria-hidden="true"
		><rect x="3" y="4" width="18" height="17" rx="3" /><path d="M3 9h18M8 2v4M16 2v4" /></svg
	>
{:else if name === 'slack'}
	<svg class={cls} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
		><path
			d="M5 15a2 2 0 1 1-2-2h2v2Zm1 0a2 2 0 1 1 4 0v5a2 2 0 1 1-4 0v-5Zm3-10a2 2 0 1 1 2-2v2H9Zm0 1a2 2 0 1 1 0 4H4a2 2 0 1 1 0-4h5Zm10 3a2 2 0 1 1 2 2h-2V9Zm-1 0a2 2 0 1 1-4 0V4a2 2 0 1 1 4 0v5Zm-3 10a2 2 0 1 1-2 2v-2h2Zm0-1a2 2 0 1 1 0-4h5a2 2 0 1 1 0 4h-5Z"
		/></svg
	>
{:else}
	<svg
		class={cls}
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		aria-hidden="true"
		><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M9 12h6M12 9v6" /></svg
	>
{/if}
