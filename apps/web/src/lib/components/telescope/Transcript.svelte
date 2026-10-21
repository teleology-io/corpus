<script lang="ts">
	import { Copy, Search } from '@lucide/svelte';
	import { fmtDuration, type TranscriptSegment } from '#lib/telescope.js';
	import { toast } from '#lib/stores/toast.svelte.js';

	let {
		segments,
		time = $bindable(0)
	}: {
		segments: TranscriptSegment[];
		/** Player position in seconds; clicking a line seeks by setting it. */
		time?: number;
	} = $props();

	let q = $state('');
	let list: HTMLOListElement | undefined = $state();
	let hovering = $state(false);

	const active = $derived.by(() => {
		let idx = -1;
		for (let i = 0; i < segments.length; i++) {
			if (segments[i]!.start <= time + 0.05) idx = i;
			else break;
		}
		return idx;
	});
	const shown = $derived(
		segments
			.map((s, i) => ({ ...s, i }))
			.filter((s) => !q.trim() || s.text.toLowerCase().includes(q.trim().toLowerCase()))
	);

	// Follow playback unless the user is reading/scrolling the list.
	$effect(() => {
		if (active < 0 || hovering || !list) return;
		list
			.querySelector(`[data-i="${active}"]`)
			?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	});

	function copyAll() {
		void navigator.clipboard.writeText(segments.map((s) => s.text).join(' '));
		toast('Transcript copied', { tone: 'success' });
	}
</script>

<div class="flex min-h-0 flex-1 flex-col">
	<div class="flex items-center gap-2 border-b border-line px-3 py-2">
		<label class="relative flex-1">
			<Search
				class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-gray-400"
			/>
			<input class="input h-8 pl-8 text-xs" placeholder="Search transcript" bind:value={q} />
		</label>
		<button class="btn-icon size-8" aria-label="Copy transcript" onclick={copyAll}
			><Copy class="size-3.5" /></button
		>
	</div>
	<ol
		bind:this={list}
		class="min-h-0 flex-1 scrollbar-thin space-y-0.5 overflow-y-auto p-2"
		onpointerenter={() => (hovering = true)}
		onpointerleave={() => (hovering = false)}
	>
		{#each shown as s (s.i)}
			<li data-i={s.i}>
				<button
					class="flex w-full gap-3 rounded-lg px-2 py-1.5 text-left text-[13px] leading-relaxed transition-colors {s.i ===
					active
						? 'bg-primary-50 text-ink'
						: 'text-gray-600 hover:bg-canvas'}"
					onclick={() => (time = s.start)}
				>
					<span
						class="mt-px shrink-0 text-[11px] font-medium tabular-nums {s.i === active
							? 'text-primary-600'
							: 'text-gray-400'}">{fmtDuration(s.start * 1000)}</span
					>
					<span>{s.text}</span>
				</button>
			</li>
		{:else}
			<li class="px-2 py-6 text-center text-xs text-muted">No matches</li>
		{/each}
	</ol>
</div>
