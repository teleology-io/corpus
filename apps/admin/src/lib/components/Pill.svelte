<script lang="ts" module>
	export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	let { tone = 'neutral', children }: { tone?: Tone; children: Snippet } = $props();

	const tones: Record<Tone, string> = {
		ok: 'bg-emerald-50 text-emerald-800',
		warn: 'bg-amber-50 text-amber-800',
		bad: 'bg-red-50 text-red-700',
		info: 'bg-primary-50 text-primary-700',
		neutral: 'bg-gray-100 text-gray-600'
	};
</script>

<span
	class="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap {tones[
		tone
	]}"
>
	<span class="size-1.5 rounded-full bg-current opacity-70"></span>
	{@render children()}
</span>
