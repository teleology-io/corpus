<script lang="ts">
	import { onMount } from 'svelte';
	import { Bell, Pill } from '@lucide/svelte';
	import EventCard from './EventCard.svelte';
	import {
		HOUR_PX,
		DAY_NAMES,
		atLocal,
		datesBetween,
		formatTime,
		gmtLabel,
		layoutDay,
		localDate,
		minutesInto,
		snap,
		tint,
		weekday
	} from '#lib/calendar.js';
	import type { CycleBandDTO, DoseDTO, OccurrenceDTO, ReminderOccurrenceDTO } from '#lib/types.js';

	let {
		start,
		end,
		today,
		tz,
		occurrences,
		bands,
		doses,
		reminders,
		oncreate,
		onopen,
		onmove,
		ondose
	}: {
		start: string;
		end: string;
		today: string;
		tz: string;
		occurrences: OccurrenceDTO[];
		bands: CycleBandDTO[];
		doses: DoseDTO[];
		reminders: ReminderOccurrenceDTO[];
		oncreate: (start: string, end: string, allDay?: boolean) => void;
		onopen: (occ: OccurrenceDTO) => void;
		onmove: (occ: OccurrenceDTO, start: string, end: string) => void;
		ondose: (dose: DoseDTO) => void;
	} = $props();

	const days = $derived(datesBetween(start, end));
	const hours = Array.from({ length: 24 }, (_, i) => i);

	let now = $state(new Date());
	let scroller: HTMLDivElement;

	onMount(() => {
		scroller.scrollTop = HOUR_PX * 7.5;
		const t = setInterval(() => (now = new Date()), 60_000);
		return () => clearInterval(t);
	});

	const nowMin = $derived(minutesInto(localDate(now, tz), now.toISOString(), tz));

	const allDay = $derived(
		occurrences.filter(
			(o) => o.allDay || new Date(o.end).getTime() - new Date(o.start).getTime() >= 86_400_000
		)
	);
	const timed = $derived(occurrences.filter((o) => !allDay.includes(o)));

	function columnFor(date: string) {
		const items = timed
			.map((o) => ({
				item: o,
				startMin: minutesInto(date, o.start, tz),
				endMin: minutesInto(date, o.end, tz)
			}))
			.filter((x) => x.endMin > 0 && x.startMin < 1440);
		return layoutDay(items);
	}

	const columns = $derived(days.map((d) => ({ date: d, placed: columnFor(d) })));

	function allDayFor(date: string) {
		// End is exclusive: an all-day event ending at midnight doesn't cover that day.
		return allDay.filter(
			(o) =>
				localDate(new Date(o.start), tz) <= date &&
				date <= localDate(new Date(new Date(o.end).getTime() - 1), tz)
		);
	}

	function bandsFor(date: string) {
		return bands.filter((b) => b.start <= date && date <= b.end && b.status === 'on');
	}

	function markersFor(date: string) {
		const ds = doses
			.filter((d) => localDate(new Date(d.at), tz) === date)
			.map((d) => ({ kind: 'dose' as const, at: d.at, dose: d }));
		const rs = reminders
			.filter((r) => localDate(new Date(r.at), tz) === date)
			.map((r) => ({ kind: 'reminder' as const, at: r.at, reminder: r }));
		return [...ds, ...rs];
	}

	// ---------- pointer interactions ----------

	type Drag =
		| { kind: 'create'; date: string; anchor: number; current: number }
		| {
				kind: 'move';
				occ: OccurrenceDTO;
				date: string;
				offset: number;
				duration: number;
				startMin: number;
				moved: boolean;
				originX: number;
				originY: number;
		  }
		| { kind: 'resize'; occ: OccurrenceDTO; date: string; startMin: number; endMin: number };

	let drag = $state<Drag | null>(null);

	function minuteAt(e: PointerEvent, col: HTMLElement) {
		const rect = col.getBoundingClientRect();
		return Math.max(0, Math.min(1440, ((e.clientY - rect.top) / HOUR_PX) * 60));
	}

	function dateAt(e: PointerEvent): string | null {
		const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-day]');
		return el?.dataset.day ?? null;
	}

	function colEl(date: string) {
		return document.querySelector<HTMLElement>(`[data-day="${date}"]`)!;
	}

	function beginCreate(e: PointerEvent, date: string) {
		if (e.button !== 0 || (e.target as HTMLElement).closest('[data-occ]')) return;
		const m = snap(minuteAt(e, e.currentTarget as HTMLElement));
		drag = { kind: 'create', date, anchor: m, current: m + 30 };
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}

	function beginMove(e: PointerEvent, occ: OccurrenceDTO, date: string) {
		if (e.button !== 0 || !occ.canEdit) return;
		e.stopPropagation();
		const col = colEl(date);
		const startMin = minutesInto(date, occ.start, tz);
		drag = {
			kind: 'move',
			occ,
			date,
			offset: minuteAt(e, col) - startMin,
			duration: (new Date(occ.end).getTime() - new Date(occ.start).getTime()) / 60_000,
			startMin,
			moved: false,
			originX: e.clientX,
			originY: e.clientY
		};
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}

	function beginResize(e: PointerEvent, occ: OccurrenceDTO, date: string) {
		if (e.button !== 0 || !occ.canEdit) return;
		e.stopPropagation();
		drag = {
			kind: 'resize',
			occ,
			date,
			startMin: minutesInto(date, occ.start, tz),
			endMin: minutesInto(date, occ.end, tz)
		};
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}

	function onPointerMove(e: PointerEvent) {
		if (!drag) return;
		if (drag.kind === 'create') {
			drag.current = snap(minuteAt(e, colEl(drag.date)));
		} else if (drag.kind === 'move') {
			if (!drag.moved && Math.hypot(e.clientX - drag.originX, e.clientY - drag.originY) < 4) return;
			drag.moved = true;
			const date = dateAt(e) ?? drag.date;
			drag.date = date;
			drag.startMin = Math.max(
				0,
				Math.min(1440 - 15, snap(minuteAt(e, colEl(date)) - drag.offset))
			);
		} else {
			drag.endMin = Math.max(drag.startMin + 15, snap(minuteAt(e, colEl(drag.date))));
		}
	}

	function iso(date: string, minutes: number) {
		return new Date(atLocal(date, '00:00', tz).getTime() + minutes * 60_000).toISOString();
	}

	function onPointerUp() {
		const d = drag;
		drag = null;
		if (!d) return;
		if (d.kind === 'create') {
			const a = Math.min(d.anchor, d.current);
			const b = Math.max(d.anchor, d.current);
			oncreate(iso(d.date, a), iso(d.date, b === a ? a + 60 : b));
		} else if (d.kind === 'move') {
			if (!d.moved) onopen(d.occ);
			else onmove(d.occ, iso(d.date, d.startMin), iso(d.date, d.startMin + d.duration));
		} else {
			onmove(d.occ, d.occ.start, iso(d.date, d.endMin));
		}
	}

	const ghost = $derived.by(() => {
		if (!drag) return null;
		if (drag.kind === 'create') {
			const a = Math.min(drag.anchor, drag.current);
			const b = Math.max(drag.anchor, drag.current, a + 15);
			return {
				date: drag.date,
				top: (a / 60) * HOUR_PX,
				height: ((b - a) / 60) * HOUR_PX,
				label: `${formatTime(iso(drag.date, a), tz)} - ${formatTime(iso(drag.date, b), tz)}`
			};
		}
		if (drag.kind === 'move' && drag.moved) {
			return {
				date: drag.date,
				top: (drag.startMin / 60) * HOUR_PX,
				height: (drag.duration / 60) * HOUR_PX,
				label: `${formatTime(iso(drag.date, drag.startMin), tz)}`,
				color: drag.occ.color
			};
		}
		if (drag.kind === 'resize') {
			return {
				date: drag.date,
				top: (drag.startMin / 60) * HOUR_PX,
				height: ((drag.endMin - drag.startMin) / 60) * HOUR_PX,
				label: `until ${formatTime(iso(drag.date, drag.endMin), tz)}`,
				color: drag.occ.color
			};
		}
		return null;
	});

	const hourLabel = (h: number) => (h === 0 ? '' : `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`);
</script>

<svelte:window onpointermove={onPointerMove} onpointerup={onPointerUp} />

<div class="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface">
	<!-- header -->
	<div
		class="grid shrink-0 border-b border-line"
		style:grid-template-columns="64px repeat({days.length}, minmax(0, 1fr))"
	>
		<div
			class="flex items-center justify-center border-r border-line text-[11px] font-medium text-muted"
		>
			{gmtLabel(tz)}
		</div>
		{#each days as d (d)}
			{@const isToday = d === today}
			<div
				class="relative border-r border-line px-2 py-3 text-center last:border-r-0 {isToday
					? 'bg-primary-50/60'
					: ''}"
			>
				{#if isToday}<span class="absolute inset-x-0 top-0 h-0.5 bg-primary-500"></span>{/if}
				<span class="text-[13px] {isToday ? 'font-semibold text-primary-600' : 'text-muted'}">
					<span class="hidden xl:inline">{DAY_NAMES[weekday(d)]}</span><span class="xl:hidden"
						>{DAY_NAMES[weekday(d)]!.slice(0, 3)}</span
					>
					<span class="font-semibold {isToday ? '' : 'text-ink'}">{Number(d.slice(8))}</span>
				</span>
			</div>
		{/each}
	</div>

	<!-- all-day + cycle bands -->
	{#if allDay.length || bands.some((b) => b.status === 'on')}
		<div
			class="grid shrink-0 border-b border-line"
			style:grid-template-columns="64px repeat({days.length}, minmax(0, 1fr))"
		>
			<div class="border-r border-line py-1.5 text-center text-[10px] text-muted">all-day</div>
			{#each days as d (d)}
				<div class="space-y-1 border-r border-line p-1 last:border-r-0">
					{#each bandsFor(d) as b (b.cycleId)}
						<a
							href="/cycles/{b.cycleId}"
							class="flex items-center gap-1 truncate rounded px-1.5 py-0.5 text-[10px] font-semibold"
							style:background={tint(b.color, 0.14)}
							style:color={b.color}
							title="{b.name} — on phase (cycle {b.cycleNumber})"
						>
							<Pill class="size-3 shrink-0" />{b.name}
						</a>
					{/each}
					{#each allDayFor(d) as o (o.key)}
						<button class="block w-full" onclick={() => onopen(o)}
							><EventCard occ={o} {tz} height={24} compact /></button
						>
					{/each}
				</div>
			{/each}
		</div>
	{/if}

	<!-- grid -->
	<div bind:this={scroller} class="relative min-h-0 flex-1 scrollbar-thin overflow-y-auto">
		<div
			class="grid"
			style:grid-template-columns="64px repeat({days.length}, minmax(0, 1fr))"
			style:height="{HOUR_PX * 24}px"
		>
			<div class="relative border-r border-line">
				{#each hours as h (h)}
					<span
						class="absolute right-2 -translate-y-1/2 text-[11px] text-muted"
						style:top="{h * HOUR_PX}px">{hourLabel(h)}</span
					>
				{/each}
				{#if days.includes(localDate(now, tz))}
					<span
						class="absolute right-1 z-20 -translate-y-1/2 rounded-full bg-primary-500 px-1.5 py-0.5 text-[10px] font-semibold text-white"
						style:top="{(nowMin / 60) * HOUR_PX}px"
						>{formatTime(now, tz).replace(/ [AP]M/, '')}</span
					>
				{/if}
			</div>

			{#each columns as col (col.date)}
				{@const isPast = col.date < today}
				{@const isToday = col.date === today}
				<div
					data-day={col.date}
					role="grid"
					tabindex="-1"
					class="relative border-r border-line last:border-r-0 {isPast
						? 'hatch'
						: ''} touch-none select-none"
					onpointerdown={(e) => beginCreate(e, col.date)}
					ondblclick={(e) => {
						if (!(e.target as HTMLElement).closest('[data-occ]')) {
							const m = snap((e.offsetY / HOUR_PX) * 60);
							oncreate(iso(col.date, m), iso(col.date, m + 60));
						}
					}}
				>
					{#each hours as h (h)}
						<div
							class="pointer-events-none absolute inset-x-0 border-t border-line/70"
							style:top="{h * HOUR_PX}px"
						></div>
					{/each}
					{#if isToday}
						<div
							class="pointer-events-none absolute inset-x-0 top-0 hatch"
							style:height="{(nowMin / 60) * HOUR_PX}px"
						></div>
					{/if}

					{#each col.placed as p (p.item.key)}
						{@const dragging =
							drag &&
							drag.kind !== 'create' &&
							drag.occ.key === p.item.key &&
							(drag.kind === 'resize' || drag.moved)}
						<div
							data-occ
							role="button"
							tabindex="0"
							class="group absolute z-10 p-0.5 {p.item.canEdit
								? 'cursor-grab active:cursor-grabbing'
								: 'cursor-pointer'} {dragging ? 'opacity-40' : ''}"
							style:top="{p.top}px"
							style:height="{p.height}px"
							style:left="calc({(p.col / p.cols) * 100}% + 2px)"
							style:width="calc({100 / p.cols}% - 4px)"
							onpointerdown={(e) => beginMove(e, p.item, col.date)}
							onkeydown={(e) => e.key === 'Enter' && onopen(p.item)}
						>
							<EventCard occ={p.item} {tz} height={p.height} />
							{#if p.item.canEdit}
								<span
									role="presentation"
									class="absolute inset-x-2 bottom-0 h-2 cursor-ns-resize opacity-0 group-hover:opacity-100"
									onpointerdown={(e) => beginResize(e, p.item, col.date)}
								>
									<span
										class="mx-auto mt-1 block h-0.5 w-6 rounded bg-current"
										style:color={p.item.color}
									></span>
								</span>
							{/if}
						</div>
					{/each}

					{#each markersFor(col.date) as m (m.kind + m.at + (m.kind === 'dose' ? m.dose.cycleId : m.reminder.reminderId))}
						{@const top = (minutesInto(col.date, m.at, tz) / 60) * HOUR_PX}
						{#if m.kind === 'dose'}
							<button
								data-occ
								class="absolute right-1 z-[11] flex -translate-y-1/2 items-center gap-1 rounded-full border bg-surface px-1.5 py-0.5 text-[10px] font-semibold shadow-card"
								style:top="{top}px"
								style:color={m.dose.color}
								style:border-color={tint(m.dose.color, 0.4)}
								title="{m.dose.name}{m.dose.doseLabel ? ` · ${m.dose.doseLabel}` : ''} — {m.dose
									.status ?? 'due'}"
								onclick={() => ondose(m.dose)}
							>
								<Pill class="size-3" />
								{#if m.dose.status === 'taken'}✓{:else if m.dose.status === 'skipped'}–{/if}
							</button>
						{:else}
							<span
								data-occ
								class="absolute left-1 z-[11] flex -translate-y-1/2 items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-amber-200"
								style:top="{top}px"
								title={m.reminder.title}
							>
								<Bell class="size-3" /><span class="max-w-20 truncate">{m.reminder.title}</span>
							</span>
						{/if}
					{/each}

					{#if ghost && ghost.date === col.date}
						<div
							class="pointer-events-none absolute inset-x-1 z-20 rounded-lg border-2 border-dashed px-2 py-1 text-[11px] font-semibold"
							style:top="{ghost.top}px"
							style:height="{ghost.height}px"
							style:border-color={'color' in ghost ? ghost.color : '#2C87F2'}
							style:background={tint(
								'color' in ghost && ghost.color ? ghost.color : '#2C87F2',
								0.08
							)}
							style:color={'color' in ghost ? ghost.color : '#2C87F2'}
						>
							{ghost.label}
						</div>
					{/if}
				</div>
			{/each}
		</div>

		{#if days.includes(localDate(now, tz))}
			<div
				class="pointer-events-none absolute right-0 left-16 z-[15] flex items-center"
				style:top="{(nowMin / 60) * HOUR_PX}px"
			>
				<span class="-ml-1 size-2 rounded-full bg-primary-500"></span>
				<span class="h-0.5 flex-1 bg-primary-500"></span>
			</div>
		{/if}
	</div>
</div>
