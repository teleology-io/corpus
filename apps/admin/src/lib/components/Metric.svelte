<script lang="ts">
	let {
		label,
		value,
		hint,
		tone = 'neutral'
	}: {
		label: string;
		value: string | number;
		hint?: string;
		tone?: 'neutral' | 'warn' | 'bad';
	} = $props();
	const color = { neutral: '', warn: 'text-amber-600', bad: 'text-red-600' };
</script>

<div class="rounded-xl border border-line bg-surface p-5 shadow-card">
	<p class="text-xs text-muted">{label}</p>
	<p class="mt-2 text-3xl font-bold tracking-tight {color[tone]}">{value}</p>
	{#if hint}<p class="mt-1 text-xs text-muted">{hint}</p>{/if}
</div>
