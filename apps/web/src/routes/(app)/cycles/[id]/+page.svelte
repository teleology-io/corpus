<script lang="ts">
	import { goto, refreshAll } from '$app/navigation';
	import { ArrowLeft, Check, Minus, Pencil, Trash2, Pill } from '@lucide/svelte';
	import CycleModal from '#lib/components/cycles/CycleModal.svelte';
	import { api } from '#lib/api.js';
	import { attempt } from '#lib/stores/toast.svelte.js';
	import { formatDay, formatTime, localDate, tint } from '#lib/calendar.js';
	import type { DoseDTO } from '#lib/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const tz = $derived(data.user.timezone);
	const c = $derived(data.cycle);
	let editOpen = $state(false);

	async function log(d: DoseDTO, status: 'taken' | 'skipped' | null) {
		await attempt(() =>
			api('/api/doses', {
				body: { cycleId: d.cycleId, at: d.at, status: d.status === status ? null : status }
			})
		);
		await refreshAll();
	}

	async function remove() {
		if (!confirm(`Delete “${c.name}” and its dose history?`)) return;
		await attempt(() => api(`/api/cycles/${c.id}`, { method: 'DELETE' }));
		await goto('/cycles');
	}

	const rate = $derived(data.stats.rate === null ? '—' : `${Math.round(data.stats.rate * 100)}%`);
</script>

<div class="mx-auto max-w-4xl space-y-6 p-4 lg:p-8">
	<a href="/cycles" class="inline-flex items-center gap-1 text-sm text-muted hover:text-ink"
		><ArrowLeft class="size-4" /> Cycles</a
	>

	<div class="flex flex-wrap items-center gap-4 card p-5">
		<span
			class="flex size-12 items-center justify-center rounded-xl"
			style:background={tint(c.color, 0.12)}
			style:color={c.color}><Pill class="size-6" /></span
		>
		<div class="min-w-0 flex-1">
			<h2 class="text-xl font-semibold">{c.name}</h2>
			<p class="text-sm text-muted">
				{data.summary}{c.doseLabel ? ` · ${c.doseLabel}` : ''} · since {formatDay(c.startDate, {
					month: 'short',
					day: 'numeric',
					year: 'numeric'
				})}
			</p>
		</div>
		<button class="btn-outline" onclick={() => (editOpen = true)}
			><Pencil class="size-4" /> Edit</button
		>
		<button class="btn-icon hover:text-red-600" aria-label="Delete cycle" onclick={remove}
			><Trash2 class="size-4" /></button
		>
	</div>

	<div class="grid gap-4 sm:grid-cols-3">
		<div class="card p-4">
			<p class="text-xs text-muted">Current phase</p>
			<p class="mt-1 text-lg font-semibold capitalize">
				{#if c.pausedAt}Paused{:else if data.phase.status === 'on' || data.phase.status === 'off'}{data
						.phase.status} · day {data.phase.dayOfPhase}/{data.phase
						.phaseLength}{:else}{data.phase.status.replace('_', ' ')}{/if}
			</p>
		</div>
		<div class="card p-4">
			<p class="text-xs text-muted">Adherence (30 days)</p>
			<p class="mt-1 text-lg font-semibold">{rate}</p>
			<p class="text-xs text-muted">{data.stats.taken} of {data.stats.scheduled} doses</p>
		</div>
		<div class="card p-4">
			<p class="text-xs text-muted">Next phase</p>
			<p class="mt-1 text-lg font-semibold">
				{#if (data.phase.status === 'on' || data.phase.status === 'off') && data.phase.nextPhaseStart}{formatDay(
						data.phase.nextPhaseStart,
						{ month: 'short', day: 'numeric' }
					)}{:else}—{/if}
			</p>
		</div>
	</div>

	<div class="grid gap-4 md:grid-cols-2">
		<section class="card">
			<h3 class="border-b border-line px-4 py-3 text-sm font-semibold">Recent doses</h3>
			<ul class="divide-y divide-line">
				{#each data.recent as d (d.at)}
					<li class="flex items-center gap-3 px-4 py-2.5">
						<div class="flex-1 text-sm">
							{formatDay(localDate(new Date(d.at), tz), {
								weekday: 'short',
								month: 'short',
								day: 'numeric'
							})}
							<span class="text-muted">· {formatTime(d.at, tz)}</span>
						</div>
						<button
							class="btn h-7 px-2 text-xs {d.status === 'taken'
								? 'bg-emerald-500 text-white'
								: 'border border-line text-muted hover:text-ink'}"
							onclick={() => log(d, 'taken')}><Check class="size-3.5" /> Taken</button
						>
						<button
							class="btn h-7 px-2 text-xs {d.status === 'skipped'
								? 'bg-ink text-surface'
								: 'border border-line text-muted hover:text-ink'}"
							onclick={() => log(d, 'skipped')}><Minus class="size-3.5" /> Skip</button
						>
					</li>
				{:else}
					<li class="px-4 py-6 text-center text-sm text-muted">No doses in the last 2 weeks.</li>
				{/each}
			</ul>
		</section>
		<section class="card">
			<h3 class="border-b border-line px-4 py-3 text-sm font-semibold">Upcoming (7 days)</h3>
			<ul class="divide-y divide-line">
				{#each data.upcoming as d (d.at)}
					<li class="px-4 py-2.5 text-sm">
						{formatDay(localDate(new Date(d.at), tz), {
							weekday: 'short',
							month: 'short',
							day: 'numeric'
						})}
						<span class="text-muted">· {formatTime(d.at, tz)}</span>
					</li>
				{:else}
					<li class="px-4 py-6 text-center text-sm text-muted">
						Off phase — no doses this week. 🎉
					</li>
				{/each}
			</ul>
		</section>
	</div>

	{#if c.notes}
		<section class="card p-4">
			<h3 class="text-sm font-semibold">Notes</h3>
			<p class="mt-1 text-sm whitespace-pre-wrap text-muted">{c.notes}</p>
		</section>
	{/if}
</div>

<CycleModal
	bind:open={editOpen}
	{tz}
	today={localDate(new Date(), tz)}
	editing={c}
	onsaved={() => refreshAll()}
/>
