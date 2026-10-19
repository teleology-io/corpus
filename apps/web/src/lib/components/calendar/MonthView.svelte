<script lang="ts">
	import { Pill } from '@lucide/svelte';
	import { DAY_NAMES, datesBetween, formatTime, localDate, tint, weekday } from '#lib/calendar.js';
	import type { CycleBandDTO, OccurrenceDTO } from '#lib/types.js';

	let {
		start,
		end,
		month,
		today,
		tz,
		occurrences,
		bands,
		oncreate,
		onopen,
		onday
	}: {
		start: string;
		end: string;
		month: string; // YYYY-MM
		today: string;
		tz: string;
		occurrences: OccurrenceDTO[];
		bands: CycleBandDTO[];
		oncreate: (date: string) => void;
		onopen: (occ: OccurrenceDTO) => void;
		onday: (date: string) => void;
	} = $props();

	const days = $derived(datesBetween(start, end));
	const MAX = 3;

	const byDay = $derived.by(() => {
		const map: Record<string, OccurrenceDTO[]> = {};
		for (const o of occurrences) {
			const first = localDate(new Date(o.start), tz);
			const last = localDate(
				new Date(Math.max(new Date(o.start).getTime(), new Date(o.end).getTime() - 1)),
				tz
			);
			for (const d of days) {
				if (d >= first && d <= last) (map[d] ??= []).push(o);
			}
		}
		return map;
	});

	const onBands = (d: string) =>
		bands.filter((b) => b.status === 'on' && b.start <= d && d <= b.end);
</script>

<div class="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface">
	<div class="grid shrink-0 grid-cols-7 border-b border-line">
		{#each days.slice(0, 7) as d (d)}
			<div class="py-2.5 text-center text-xs font-medium text-muted">
				{DAY_NAMES[weekday(d)]!.slice(0, 3)}
			</div>
		{/each}
	</div>
	<div class="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
		{#each days as d (d)}
			{@const items = byDay[d] ?? []}
			{@const outside = !d.startsWith(month)}
			<div
				role="button"
				tabindex="-1"
				class="group flex min-h-24 flex-col gap-0.5 border-r border-b border-line p-1.5 text-left nth-[7n]:border-r-0 {outside
					? 'bg-canvas/60'
					: ''}"
				ondblclick={() => oncreate(d)}
				onkeydown={(e) => e.key === 'Enter' && oncreate(d)}
			>
				<div class="flex items-center justify-between">
					<button
						class="flex size-6 items-center justify-center rounded-full text-xs font-semibold {d ===
						today
							? 'bg-primary-500 text-white'
							: outside
								? 'text-gray-400'
								: 'text-ink hover:bg-canvas'}"
						onclick={() => onday(d)}>{Number(d.slice(8))}</button
					>
					<div class="flex gap-0.5">
						{#each onBands(d) as b (b.cycleId)}
							<span title="{b.name} (on)" style:color={b.color}><Pill class="size-3" /></span>
						{/each}
					</div>
				</div>
				{#each items.slice(0, MAX) as o (o.key)}
					<button
						class="flex w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-left text-[11px] font-medium"
						style:background={tint(o.color, 0.1)}
						style:color={o.color}
						onclick={() => onopen(o)}
					>
						{#if !o.allDay}<span class="shrink-0 opacity-70"
								>{formatTime(o.start, tz, { compact: true })}</span
							>{/if}
						<span class="truncate">{o.title}</span>
					</button>
				{/each}
				{#if items.length > MAX}
					<button
						class="px-1.5 text-left text-[11px] font-medium text-muted hover:text-ink"
						onclick={() => onday(d)}
					>
						+{items.length - MAX} more
					</button>
				{/if}
			</div>
		{/each}
	</div>
</div>
