<script lang="ts">
	import ActionButton from '#lib/components/ActionButton.svelte';
	import Card from '#lib/components/Card.svelte';
	import Confirm from '#lib/components/Confirm.svelte';
	import Drawer from '#lib/components/Drawer.svelte';
	import Empty from '#lib/components/Empty.svelte';
	import Pill from '#lib/components/Pill.svelte';
	import Time from '#lib/components/Time.svelte';
	import { duration } from '#lib/format.js';
	import { invalidate } from '$app/navigation';
	import { LoaderCircle, RefreshCw, TriangleAlert } from '@lucide/svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const j = $derived(data.selected);

	// After Run now: poll this job's history until the manual run lands (or give up after 2 min).
	// invalidate() reruns the load without touching the URL, so the drawer stays open.
	let pending = $state<{ job: string; since: number } | null>(null);
	/** A requested run that hasn't reported within the polling window. */
	let timedOut = $state<{ job: string; since: number } | null>(null);
	const ranSince = (since: number) =>
		!!data.runs?.some(
			(r) => r.trigger === 'manual' && new Date(r.startedAt).getTime() >= since - 5_000
		);
	let checking = $state(false);
	async function reload() {
		checking = true;
		try {
			await invalidate('admin:jobs');
		} finally {
			checking = false;
		}
	}
	const landed = $derived(
		!!pending &&
			pending.job === j?.name &&
			!!data.runs?.some(
				(r) => r.trigger === 'manual' && new Date(r.startedAt).getTime() >= pending!.since - 5_000
			)
	);
	// A late result (seen via Refresh history) clears the timeout notice.
	$effect(() => {
		if (timedOut && timedOut.job === j?.name && ranSince(timedOut.since)) timedOut = null;
	});
	$effect(() => {
		if (!pending) return;
		if (landed || pending.job !== j?.name) {
			pending = null;
			return;
		}
		const started = pending.since;
		const t = setInterval(() => {
			if (Date.now() - started > 120_000) {
				timedOut = pending;
				pending = null;
			} else void reload();
		}, 3_000);
		return () => clearInterval(t);
	});
</script>

{#snippet status(job: (typeof data.jobs)[number])}
	{#if job.paused}<Pill tone="warn">Paused</Pill>
	{:else if job.lastOk === false}<Pill tone="bad">Failed</Pill>
	{:else if job.lastOk === null}<Pill>Not run yet</Pill>
	{:else}<Pill tone="ok">Healthy</Pill>{/if}
{/snippet}

<Card
	title="Background jobs"
	subtitle="Run by the worker. Paused jobs skip scheduled runs; Run now still works."
	flush
>
	<div class="table-wrap">
		<table class="table">
			<thead>
				<tr>
					<th>Job</th><th>Status</th><th>Last run</th><th>Duration</th><th>Last 24h</th><th
						>Latest result</th
					>
					<th><span class="sr-only">Actions</span></th>
				</tr>
			</thead>
			<tbody>
				{#each data.jobs as job (job.name)}
					<tr>
						<td>
							<p class="font-medium">{job.label}</p>
							<p class="text-xs text-muted">{job.schedule}</p>
						</td>
						<td>{@render status(job)}</td>
						<td class="whitespace-nowrap text-muted"><Time at={job.lastStartedAt} /></td>
						<td class="text-muted">{duration(job.lastDurationMs)}</td>
						<td class="whitespace-nowrap text-muted">
							{job.runs24h} runs{#if job.failures24h}<span class="text-red-600">
									· {job.failures24h} failed</span
								>{/if}
						</td>
						<td class="max-w-64 truncate text-xs text-muted" title={job.lastError ?? ''}>
							{job.paused ? `Paused by ${job.pausedBy}` : (job.lastError ?? '—')}
						</td>
						<td class="text-right">
							<a
								class="btn"
								href="?job={job.name}"
								data-sveltekit-noscroll
								aria-label="View history for {job.label}">History</a
							>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</Card>

<Drawer param="job" title={j?.label ?? 'Job'}>
	{#if j}
		<div class="flex items-center gap-2">
			{@render status(j)}
			<span class="text-xs text-muted">{j.schedule}</span>
		</div>
		<dl class="mt-3">
			<div class="detail">
				<dt>Latest result</dt>
				<dd>
					{#if j.lastOk === false}<span class="font-mono text-xs break-all text-red-700"
							>{j.lastError}</span
						>
					{:else if j.lastOk}Succeeded <Time at={j.lastStartedAt} /> in {duration(j.lastDurationMs)}
					{:else}No runs recorded yet{/if}
				</dd>
			</div>
			{#if j.paused}
				<div class="detail">
					<dt>Paused by</dt>
					<dd>{j.pausedBy}</dd>
				</div>
			{/if}
		</dl>

		<div class="mt-5 flex flex-wrap gap-2">
			<ActionButton
				action="?/run"
				fields={{ job: j.name }}
				primary
				success="Run requested for {j.label}. Waiting for the worker to finish it."
				onsuccess={() => {
					timedOut = null;
					pending = { job: j.name, since: Date.now() };
				}}
			>
				Run now
			</ActionButton>
			{#if j.paused}
				<ActionButton
					action="?/resume"
					fields={{ job: j.name }}
					success="{j.label} resumed. Scheduled runs start again."
				>
					Resume
				</ActionButton>
			{:else}
				<Confirm
					action="?/pause"
					fields={{ job: j.name }}
					title="Pause {j.label}?"
					impact="Scheduled runs will be skipped until you resume it. A run already in progress finishes. Run now still works while paused."
					confirmLabel="Pause job"
					success="{j.label} paused. Scheduled runs are skipped until you resume it."
				>
					Pause job
				</Confirm>
			{/if}
		</div>
		{#if pending?.job === j.name}
			<p
				class="mt-3 flex items-center gap-2 rounded-lg bg-primary-50 px-3 py-2 text-xs text-primary-800"
				role="status"
			>
				<LoaderCircle size={14} class="shrink-0 animate-spin" aria-hidden="true" />
				Run requested. Pending until the worker reports a result; this list checks every few seconds.
			</p>
		{:else if timedOut?.job === j.name}
			<p
				class="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
				role="status"
			>
				<TriangleAlert size={14} class="mt-px shrink-0" aria-hidden="true" />
				<span>
					No result received yet. The run may still be going: use Refresh history, or
					<a href="/?service=worker" class="font-medium underline">check worker health</a>.
				</span>
			</p>
		{:else}
			<p class="mt-2 text-xs text-muted">
				Run now asks the worker to start the job. Its result appears under Recent runs, marked
				Manual, once it finishes.
			</p>
		{/if}

		<div class="mt-7 mb-2 flex items-center justify-between">
			<h3 class="text-sm font-semibold">Recent runs</h3>
			<button type="button" class="btn" onclick={reload} disabled={checking}>
				<RefreshCw size={14} class={checking ? 'animate-spin' : ''} aria-hidden="true" />
				{checking ? 'Refreshing…' : 'Refresh history'}
			</button>
		</div>
		{#if data.runs?.length}
			<ul class="divide-y divide-line text-sm">
				{#each data.runs as r (r.id)}
					<li class="py-2.5">
						<div class="flex items-center justify-between gap-3">
							<Time at={r.startedAt} full />
							<span class="flex items-center gap-2 text-xs text-muted">
								{#if r.trigger === 'manual'}<Pill tone="info">Manual</Pill>{/if}
								{duration(r.durationMs)}
								<Pill tone={r.ok ? 'ok' : 'bad'}>{r.ok ? 'OK' : 'Failed'}</Pill>
							</span>
						</div>
						{#if r.error}<p class="mt-1 font-mono text-xs break-all text-red-700">{r.error}</p>{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<Empty title="No runs yet" body="Runs appear here once the worker has run this job." />
		{/if}
	{/if}
</Drawer>
