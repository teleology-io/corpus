<script lang="ts">
	import { goto, refreshAll } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import {
		ChevronLeft,
		ChevronRight,
		Download,
		Trash2,
		UserPlus,
		Plus,
		Search,
		PencilLine,
		Link2,
		Repeat
	} from '@lucide/svelte';
	import WeekView from '#lib/components/calendar/WeekView.svelte';
	import MonthView from '#lib/components/calendar/MonthView.svelte';
	import YearView from '#lib/components/calendar/YearView.svelte';
	import EventModal from '#lib/components/calendar/EventModal.svelte';
	import TrashModal from '#lib/components/calendar/TrashModal.svelte';
	import Modal from '#lib/components/ui/Modal.svelte';
	import { api } from '#lib/api.js';
	import { attempt, toast } from '#lib/stores/toast.svelte.js';
	import {
		MONTH_NAMES,
		addDaysToDate,
		atLocal,
		formatDay,
		parseDate,
		shiftDate,
		type View
	} from '#lib/calendar.js';
	import type { DoseDTO, EditScope, OccurrenceDTO } from '#lib/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const tz = $derived(data.user.timezone);

	let modalOpen = $state(false);
	let editing = $state<OccurrenceDTO | null>(null);
	let initial = $state<{ start: string; end: string; allDay?: boolean } | null>(null);
	let trashOpen = $state(false);
	let search = $derived(data.q);
	let pendingMove = $state<{ occ: OccurrenceDTO; start: string; end: string } | null>(null);
	let moveScope = $state<EditScope>('this');

	onMount(() => {
		if (data.focusEvent) {
			const occ = data.occurrences.find((o) => o.eventId === data.focusEvent);
			if (occ) openEvent(occ);
		}
	});

	function nav(params: Partial<{ view: View; date: string; q: string }>) {
		const u = new URL(page.url.href);
		for (const [k, v] of Object.entries(params)) {
			if (v) u.searchParams.set(k, v);
			else u.searchParams.delete(k);
		}
		u.searchParams.delete('event');
		void goto(u, { reset: false });
	}

	function openCreate(start?: string, end?: string, allDay = false) {
		editing = null;
		initial = start && end ? { start, end, allDay } : null;
		modalOpen = true;
	}

	function openEvent(occ: OccurrenceDTO) {
		editing = occ;
		modalOpen = true;
	}

	function createOnDay(date: string) {
		openCreate(atLocal(date, '09:00', tz).toISOString(), atLocal(date, '10:00', tz).toISOString());
	}

	async function move(occ: OccurrenceDTO, start: string, end: string) {
		if (occ.recurring) {
			moveScope = 'this';
			pendingMove = { occ, start, end };
			return;
		}
		await applyMove({ occ, start, end }, 'all');
	}

	async function applyMove(
		m: { occ: OccurrenceDTO; start: string; end: string },
		scope: EditScope
	) {
		pendingMove = null;
		await attempt(
			() =>
				api(`/api/events/${m.occ.eventId}`, {
					method: 'PATCH',
					body: { start: m.start, end: m.end, scope, originalStart: m.occ.originalStart }
				}),
			'Could not move schedule'
		);
		await refreshAll();
	}

	async function toggleDose(d: DoseDTO) {
		const next = d.status === 'taken' ? null : 'taken';
		await attempt(() =>
			api('/api/doses', { body: { cycleId: d.cycleId, at: d.at, status: next } })
		);
		toast(next ? `${d.name} marked taken` : `${d.name} unmarked`, { tone: 'success' });
		await refreshAll();
	}

	async function copyFeed() {
		await navigator.clipboard.writeText(data.feedUrl);
		toast('Subscription link copied', {
			tone: 'success',
			body: 'Paste it into Google Calendar, Apple Calendar or Outlook.'
		});
	}

	const heading = $derived.by(() => {
		const { y, m } = parseDate(data.date);
		if (data.view === 'year') return `${y}`;
		return `${MONTH_NAMES[m - 1]} ${y}`;
	});

	const subheading = $derived.by(() => {
		if (data.view === 'week') {
			const opts: Intl.DateTimeFormatOptions = { month: 'long', day: 'numeric', year: 'numeric' };
			return `${formatDay(data.range.start, opts)} - ${formatDay(addDaysToDate(data.range.end, -1), opts)}`;
		}
		if (data.view === 'month')
			return `${data.occurrences.length} schedule${data.occurrences.length === 1 ? '' : 's'} this month`;
		return `${data.occurrences.length} schedules this year`;
	});

	const tabs: [View, string][] = [
		['week', 'Weekly'],
		['month', 'Monthly'],
		['year', 'Yearly']
	];
</script>

<svelte:head><title>My Calendar · Corpus</title></svelte:head>

<div class="flex h-full flex-col">
	<!-- tabs -->
	<div class="border-b border-line bg-surface px-4 lg:px-8">
		<nav class="-mb-px flex gap-6">
			{#each tabs as [v, label] (v)}
				<button
					class="border-b-2 py-3 text-sm font-medium transition-colors {data.view === v
						? 'border-primary-500 text-primary-600'
						: 'border-transparent text-muted hover:text-ink'}"
					onclick={() => nav({ view: v })}>{label}</button
				>
			{/each}
			<a
				href="/cycles"
				class="border-b-2 border-transparent py-3 text-sm font-medium text-muted hover:text-ink"
				>Cycles</a
			>
		</nav>
	</div>

	<div class="flex min-h-0 flex-1 flex-col gap-4 p-4 lg:px-8 lg:py-5">
		<!-- action row -->
		<div class="flex flex-wrap items-center gap-2">
			<a class="btn-outline" href="/api/calendar/export" download
				><Download class="size-4" /> Export</a
			>
			<button class="btn-outline" onclick={() => (trashOpen = true)}
				><Trash2 class="size-4" /> Deleted Schedule</button
			>
			<button class="btn-ghost" onclick={copyFeed} title="Copy subscribable calendar link"
				><Link2 class="size-4" /> Subscribe</button
			>
			<div class="ml-auto flex gap-2">
				<a class="btn-outline-primary" href="/teams"><UserPlus class="size-4" /> Invite</a>
			</div>
		</div>

		<!-- heading row -->
		<div class="flex flex-wrap items-end gap-3">
			<div>
				<div class="flex items-center gap-2">
					<h2 class="text-2xl font-bold tracking-tight">{heading}</h2>
					<label class="relative cursor-pointer text-muted hover:text-ink" title="Jump to date">
						<PencilLine class="size-4" />
						<input
							type="date"
							class="absolute inset-0 cursor-pointer opacity-0"
							value={data.date}
							onchange={(e) => nav({ date: e.currentTarget.value })}
						/>
					</label>
				</div>
				<p class="mt-0.5 text-sm text-muted">{subheading}</p>
			</div>
			<div class="ml-2 flex items-center gap-1">
				<button
					class="btn-icon size-8"
					aria-label="Previous"
					onclick={() => nav({ date: shiftDate(data.view, data.date, -1) })}
					><ChevronLeft class="size-4" /></button
				>
				<button class="btn-outline h-8 text-xs" onclick={() => nav({ date: data.today })}
					>Today</button
				>
				<button
					class="btn-icon size-8"
					aria-label="Next"
					onclick={() => nav({ date: shiftDate(data.view, data.date, 1) })}
					><ChevronRight class="size-4" /></button
				>
			</div>
			<div class="ml-auto flex items-center gap-2">
				<form class="relative" onsubmit={(e) => (e.preventDefault(), nav({ q: search.trim() }))}>
					<Search
						class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
					/>
					<input class="input h-9 w-56 pl-9" placeholder="Search now" bind:value={search} />
				</form>
				<button class="btn-primary" onclick={() => openCreate()}
					><Plus class="size-4" /> Create Schedule</button
				>
			</div>
		</div>

		{#if data.q}
			<p class="-mt-2 text-xs text-muted">
				Showing schedules matching “{data.q}” ·
				<button class="text-primary-600 hover:underline" onclick={() => nav({ q: '' })}
					>clear</button
				>
			</p>
		{/if}

		<!-- views -->
		<div class="min-h-[480px] flex-1 {data.view === 'year' ? '' : 'min-h-0'}">
			{#if data.view === 'week'}
				<WeekView
					start={data.range.start}
					end={data.range.end}
					today={data.today}
					{tz}
					occurrences={data.occurrences}
					bands={data.bands}
					doses={data.doses}
					reminders={data.reminders}
					oncreate={(s, e, a) => openCreate(s, e, a)}
					onopen={openEvent}
					onmove={move}
					ondose={toggleDose}
				/>
			{:else if data.view === 'month'}
				<MonthView
					start={data.range.start}
					end={data.range.end}
					month={data.date.slice(0, 7)}
					today={data.today}
					{tz}
					occurrences={data.occurrences}
					bands={data.bands}
					oncreate={createOnDay}
					onopen={openEvent}
					onday={(d) => nav({ view: 'week', date: d })}
				/>
			{:else}
				<YearView
					year={parseDate(data.date).y}
					today={data.today}
					{tz}
					weekStartsOn={data.user.weekStartsOn}
					occurrences={data.occurrences}
					onday={(d) => nav({ view: 'week', date: d })}
				/>
			{/if}
		</div>
	</div>
</div>

<EventModal
	bind:open={modalOpen}
	{tz}
	categories={data.categories}
	calendars={data.calendars}
	members={data.members}
	me={data.user.id}
	{editing}
	{initial}
	onsaved={() => refreshAll()}
/>
<TrashModal bind:open={trashOpen} {tz} onchange={() => refreshAll()} />

{#if pendingMove}
	<Modal
		open={true}
		title="Move recurring schedule"
		description="This schedule repeats. What should move?"
		size="sm"
	>
		{#snippet icon()}<Repeat class="size-5" />{/snippet}
		<div class="space-y-2 text-sm">
			{#each [['this', 'This event'], ['following', 'This and following events'], ['all', 'All events']] as [v, l] (v)}
				<label
					class="flex items-center gap-2 rounded-lg border border-line px-3 py-2.5 has-checked:border-primary-500 has-checked:bg-primary-50"
				>
					<input type="radio" bind:group={moveScope} value={v} class="accent-primary-500" />{l}
				</label>
			{/each}
		</div>
		{#snippet footer()}
			<div class="ml-auto flex gap-2">
				<button class="btn-outline" onclick={() => (pendingMove = null)}>Cancel</button>
				<button class="btn-primary" onclick={() => pendingMove && applyMove(pendingMove, moveScope)}
					>Move</button
				>
			</div>
		{/snippet}
	</Modal>
{/if}
