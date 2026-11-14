<script lang="ts">
	import { onMount } from 'svelte';
	import { ago } from '#lib/format.js';

	/**
	 * A timestamp shown as relative ("3 min ago") with the full date, year and timezone on hover,
	 * or as the full date when `full`. Formatted in the browser so it uses the viewer's timezone
	 * (the server would render its own zone and the two would disagree).
	 */
	let { at, full = false }: { at: Date | string | null | undefined; full?: boolean } = $props();

	let mounted = $state(false);
	let now = $state(Date.now());
	onMount(() => {
		mounted = true;
		const t = setInterval(() => (now = Date.now()), 15_000);
		return () => clearInterval(t);
	});

	const fmt = new Intl.DateTimeFormat('en-US', {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		second: '2-digit',
		timeZoneName: 'short'
	});
	const date = $derived(at ? new Date(at) : null);
	const exact = $derived(date && mounted ? fmt.format(date) : (date?.toISOString() ?? ''));
	const rel = $derived((void now, ago(date)));
</script>

{#if !date}—{:else}<time datetime={date.toISOString()} title={full ? undefined : exact}
		>{full ? exact : rel}</time
	>{/if}
