<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { Pill, Plus, Bell, Pause, Play, Trash2, Repeat } from '@lucide/svelte';
	import CycleModal from '#lib/components/cycles/CycleModal.svelte';
	import ReminderModal from '#lib/components/cycles/ReminderModal.svelte';
	import CycleTimeline from '#lib/components/cycles/CycleTimeline.svelte';
	import EmptyState from '#lib/components/ui/EmptyState.svelte';
	import Switch from '#lib/components/ui/Switch.svelte';
	import { api } from '#lib/api.js';
	import { attempt } from '#lib/stores/toast.svelte.js';
	import { formatDay, formatTime, localDate, tint } from '#lib/calendar.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let cycleOpen = $state(false);
	let reminderOpen = $state(false);
	let editingReminder = $state<(typeof data.reminders)[number] | null>(null);

	async function pause(id: string, paused: boolean) {
		await attempt(() => api(`/api/cycles/${id}`, { method: 'PATCH', body: { paused } }));
		await refreshAll();
	}

	async function toggleReminder(id: string, active: boolean) {
		await attempt(() => api(`/api/reminders/${id}`, { method: 'PATCH', body: { active } }));
		await refreshAll();
	}

	async function deleteReminder(id: string) {
		await attempt(() => api(`/api/reminders/${id}`, { method: 'DELETE' }));
		await refreshAll();
	}

	function phaseText(p: (typeof data.cycles)[number]['phase']) {
		if (p.status === 'on') return `On · day ${p.dayOfPhase} of ${p.phaseLength}`;
		if (p.status === 'off') return `Off · day ${p.dayOfPhase} of ${p.phaseLength}`;
		if (p.status === 'not_started')
			return `Starts in ${p.daysUntil} day${p.daysUntil === 1 ? '' : 's'}`;
		return 'Finished';
	}
</script>

<svelte:head><title>Cycles & Reminders · Corpus</title></svelte:head>

<div class="space-y-8 p-4 lg:p-8">
	<section>
		<div class="mb-4 flex flex-wrap items-center gap-3">
			<div>
				<h2 class="text-lg font-semibold">Cycles</h2>
				<p class="text-sm text-muted">
					On/off schedules for prescriptions, supplements or training — e.g. 6 weeks on, 3 weeks
					off.
				</p>
			</div>
			<button class="ml-auto btn-primary" onclick={() => (cycleOpen = true)}
				><Plus class="size-4" /> New cycle</button
			>
		</div>

		{#if !data.cycles.length}
			<div class="card">
				<EmptyState
					title="No cycles yet"
					body="Set up a cycle and Corpus will remind you to take each dose — only during on weeks."
				>
					{#snippet icon()}<Pill class="size-5" />{/snippet}
					{#snippet action()}<button class="btn-primary" onclick={() => (cycleOpen = true)}
							><Plus class="size-4" /> New cycle</button
						>{/snippet}
				</EmptyState>
			</div>
		{:else}
			<div class="overflow-hidden card">
				<CycleTimeline
					cycles={data.cycles}
					start={data.timeline.start}
					end={data.timeline.end}
					today={data.today}
				/>
			</div>
			<div class="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
				{#each data.cycles as c (c.id)}
					<div class="card p-4">
						<div class="flex items-start gap-3">
							<span
								class="flex size-10 shrink-0 items-center justify-center rounded-xl"
								style:background={tint(c.color, 0.12)}
								style:color={c.color}
							>
								<Pill class="size-5" />
							</span>
							<div class="min-w-0 flex-1">
								<a href="/cycles/{c.id}" class="block truncate font-semibold hover:underline"
									>{c.name}</a
								>
								<p class="text-xs text-muted">
									{c.summary}{c.doseLabel ? ` · ${c.doseLabel}` : ''}
								</p>
							</div>
							<button
								class="btn-icon size-8"
								title={c.pausedAt ? 'Resume' : 'Pause'}
								onclick={() => pause(c.id, !c.pausedAt)}
							>
								{#if c.pausedAt}<Play class="size-4" />{:else}<Pause class="size-4" />{/if}
							</button>
						</div>
						<div class="mt-4 flex items-center justify-between text-sm">
							{#if c.pausedAt}
								<span class="chip bg-gray-100 text-muted">Paused</span>
							{:else}
								<span
									class="chip"
									style:background={tint(c.color, c.phase.status === 'on' ? 0.14 : 0.06)}
									style:color={c.color}>{phaseText(c.phase)}</span
								>
							{/if}
							{#if c.phase.status === 'on' || c.phase.status === 'off'}
								<span class="text-xs text-muted"
									>Cycle {c.phase.cycleNumber}{c.repeatCount ? ` of ${c.repeatCount}` : ''}</span
								>
							{/if}
						</div>
						{#if (c.phase.status === 'on' || c.phase.status === 'off') && c.phase.nextPhaseStart}
							<p class="mt-2 text-xs text-muted">
								{c.phase.status === 'on' ? 'Break starts' : 'Next round starts'}
								{formatDay(c.phase.nextPhaseStart, {
									weekday: 'short',
									month: 'short',
									day: 'numeric'
								})}
							</p>
						{/if}
						{#if c.doseTimes.length}
							<p class="mt-1 text-xs text-muted">Doses at {c.doseTimes.join(', ')}</p>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</section>

	<section>
		<div class="mb-4 flex flex-wrap items-center gap-3">
			<div>
				<h2 class="text-lg font-semibold">Reminders</h2>
				<p class="text-sm text-muted">
					One-off or repeating nudges — they show on your dashboard and notify you.
				</p>
			</div>
			<button
				class="ml-auto btn-outline"
				onclick={() => ((editingReminder = null), (reminderOpen = true))}
				><Plus class="size-4" /> New reminder</button
			>
		</div>
		<div class="divide-y divide-line card">
			{#each data.reminders as r (r.id)}
				<div class="flex items-center gap-3 px-4 py-3">
					<span
						class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600"
						><Bell class="size-4" /></span
					>
					<button
						class="min-w-0 flex-1 text-left"
						onclick={() => ((editingReminder = r), (reminderOpen = true))}
					>
						<p class="truncate text-sm font-medium {r.active ? '' : 'text-muted line-through'}">
							{r.title}
						</p>
						<p class="flex items-center gap-1 text-xs text-muted">
							{#if r.rrule}<Repeat class="size-3" />{r.repeatText} at {formatTime(
									r.startsAt,
									r.timezone
								)}{:else}{formatDay(localDate(r.startsAt, r.timezone))} · {formatTime(
									r.startsAt,
									r.timezone
								)}{/if}
						</p>
					</button>
					<Switch checked={r.active} label="Active" onchange={(v) => toggleReminder(r.id, v)} />
					<button
						class="btn-icon size-8 hover:text-red-600"
						aria-label="Delete"
						onclick={() => deleteReminder(r.id)}><Trash2 class="size-4" /></button
					>
				</div>
			{:else}
				<EmptyState title="No reminders" body="Add one like “Take pills” every day at 8am.">
					{#snippet icon()}<Bell class="size-5" />{/snippet}
				</EmptyState>
			{/each}
		</div>
	</section>
</div>

<CycleModal
	bind:open={cycleOpen}
	tz={data.user.timezone}
	today={data.today}
	onsaved={() => refreshAll()}
/>
<ReminderModal
	bind:open={reminderOpen}
	tz={data.user.timezone}
	editing={editingReminder}
	onsaved={() => refreshAll()}
/>
