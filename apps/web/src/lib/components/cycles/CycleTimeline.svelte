<script lang="ts">
	import { datesBetween, diffDates, formatDay, tint } from '#lib/calendar.js';

	interface Row {
		id: string;
		name: string;
		color: string;
		pausedAt: Date | null;
		segments: { status: 'on' | 'off'; start: string; end: string; cycleNumber: number }[];
	}

	let { cycles, start, end, today }: { cycles: Row[]; start: string; end: string; today: string } =
		$props();

	const total = $derived(diffDates(start, end) + 1);
	const pct = (d: string) => (diffDates(start, d) / total) * 100;
	const months = $derived(datesBetween(start, end).filter((d) => d.endsWith('-01')));
</script>

<div class="overflow-x-auto">
	<div class="min-w-[720px] p-4">
		<div class="relative ml-36 h-5 text-[10px] text-muted">
			{#each months as m (m)}
				<span class="absolute -translate-x-1/2" style:left="{pct(m)}%"
					>{formatDay(m, { month: 'short' })}</span
				>
			{/each}
		</div>
		<div class="relative space-y-2">
			{#each cycles as c (c.id)}
				<div class="flex items-center">
					<a
						href="/cycles/{c.id}"
						class="w-36 shrink-0 truncate pr-3 text-xs font-medium hover:underline {c.pausedAt
							? 'text-muted'
							: ''}">{c.name}</a
					>
					<div class="relative h-6 flex-1 rounded-md bg-canvas">
						{#each c.segments as s (s.start)}
							<span
								class="absolute inset-y-0 rounded-md"
								style:left="{pct(s.start)}%"
								style:width="{((diffDates(s.start, s.end) + 1) / total) * 100}%"
								style:background={s.status === 'on'
									? tint(c.color, c.pausedAt ? 0.25 : 0.85)
									: 'transparent'}
								title="{s.status === 'on' ? 'On' : 'Off'} · {formatDay(s.start, {
									month: 'short',
									day: 'numeric'
								})} – {formatDay(s.end, { month: 'short', day: 'numeric' })}"
							></span>
						{/each}
					</div>
				</div>
			{/each}
			<span
				class="pointer-events-none absolute -top-1 -bottom-1 w-0.5 bg-primary-500"
				style:left="calc(9rem + (100% - 9rem) * {pct(today) / 100})"
			></span>
		</div>
	</div>
</div>
