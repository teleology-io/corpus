<script lang="ts">
	import {
		MONTH_NAMES,
		DAY_NAMES,
		addMonths,
		datesBetween,
		localDate,
		startOfWeek,
		addDaysToDate,
		weekday
	} from '#lib/calendar.js';
	import type { OccurrenceDTO } from '#lib/types.js';

	let {
		year,
		today,
		tz,
		weekStartsOn,
		occurrences,
		onday
	}: {
		year: number;
		today: string;
		tz: string;
		weekStartsOn: number;
		occurrences: OccurrenceDTO[];
		onday: (d: string) => void;
	} = $props();

	const counts = $derived.by(() => {
		const map: Record<string, number> = {};
		for (const o of occurrences) {
			const d = localDate(new Date(o.start), tz);
			map[d] = (map[d] ?? 0) + 1;
		}
		return map;
	});

	const months = $derived(
		Array.from({ length: 12 }, (_, i) => {
			const first = addMonths(`${year}-01-01`, i);
			const gridStart = startOfWeek(first, weekStartsOn);
			return {
				name: MONTH_NAMES[i]!,
				prefix: first.slice(0, 7),
				days: datesBetween(gridStart, addDaysToDate(gridStart, 42))
			};
		})
	);

	const heat = (n: number) =>
		n >= 4
			? 'bg-primary-500 text-white'
			: n >= 2
				? 'bg-primary-200 text-primary-800'
				: n === 1
					? 'bg-primary-50 text-primary-700'
					: '';
</script>

<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
	{#each months as m (m.prefix)}
		<div class="card p-4">
			<p class="mb-3 text-sm font-semibold">{m.name}</p>
			<div class="grid grid-cols-7 gap-y-1 text-center text-[10px] text-muted">
				{#each m.days.slice(0, 7) as d (d)}<span>{DAY_NAMES[weekday(d)]![0]}</span>{/each}
			</div>
			<div class="mt-1 grid grid-cols-7 gap-1">
				{#each m.days as d (d)}
					{@const inMonth = d.startsWith(m.prefix)}
					{@const n = counts[d] ?? 0}
					<button
						class="aspect-square rounded-md text-[11px] {inMonth
							? heat(n) || 'text-ink hover:bg-canvas'
							: 'text-gray-300'} {d === today ? 'ring-2 ring-primary-500' : ''}"
						disabled={!inMonth}
						title={n ? `${n} event${n > 1 ? 's' : ''}` : undefined}
						onclick={() => onday(d)}>{Number(d.slice(8))}</button
					>
				{/each}
			</div>
		</div>
	{/each}
</div>
