<script lang="ts">
	import Card from '#lib/components/Card.svelte';
	import Drawer from '#lib/components/Drawer.svelte';
	import Empty from '#lib/components/Empty.svelte';
	import Metric from '#lib/components/Metric.svelte';
	import Pill, { type Tone } from '#lib/components/Pill.svelte';
	import Time from '#lib/components/Time.svelte';
	import { ago } from '#lib/format.js';
	import { actionLabel } from '#lib/audit.js';
	import { page } from '$app/state';
	import { TriangleAlert } from '@lucide/svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const m = $derived(data.metrics);

	const unhealthy = $derived(data.services.filter((s) => s.health !== 'healthy'));
	const health = $derived(
		unhealthy.some((s) => s.health === 'down') ? 'Down' : unhealthy.length ? 'Degraded' : 'Healthy'
	);
	const attention = $derived(data.jobs.filter((j) => j.paused || j.lastOk === false));
	const unreported = $derived(data.jobs.filter((j) => !j.paused && j.lastOk === null));
	const rateLimited = $derived(data.providers.filter((p) => p.rateLimited > 0));
	const erroredConnections = $derived(data.providers.reduce((n, p) => n + p.errored, 0));
	const selected = $derived(
		data.services.find((s) => s.id === page.url.searchParams.get('service'))
	);

	const healthTone: Record<string, Tone> = { healthy: 'ok', degraded: 'warn', down: 'bad' };
	const healthText: Record<string, string> = {
		healthy: 'Healthy',
		degraded: 'Degraded',
		down: 'Down'
	};

	const notices = $derived([
		...unhealthy.map((s) => ({
			text: `${s.name} is ${s.health}: ${s.detail.toLowerCase()}.`,
			href: `?service=${s.id}`,
			cta: 'View service'
		})),
		...rateLimited.map((p) => ({
			text: `${p.provider} is rate limited on ${p.rateLimited} connection${p.rateLimited === 1 ? '' : 's'}.`,
			href: `/integrations?provider=${p.provider}`,
			cta: 'View connections'
		})),
		...(erroredConnections
			? [
					{
						text: `${erroredConnections} integration connection${erroredConnections === 1 ? ' is' : 's are'} in an error state.`,
						href: '/integrations',
						cta: 'View integrations'
					}
				]
			: [])
	]);
</script>

<div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
	<Metric
		label="System health"
		value={health}
		tone={health === 'Down' ? 'bad' : health === 'Degraded' ? 'warn' : 'neutral'}
		hint="{data.services.length - unhealthy.length} of {data.services.length} services healthy"
	/>
	<Metric
		label="Failed job runs"
		value={m.failedRuns}
		tone={m.failedRuns ? 'bad' : 'neutral'}
		hint="In the last 24 hours"
	/>
	<Metric
		label="Signed-in users"
		value={m.activeUsers}
		hint="{m.recentUsers} active today · {m.workspaces} workspaces"
	/>
	<Metric
		label="Queue depth"
		value={m.queueDepth}
		hint={m.oldestQueued
			? `Oldest queued ${ago(m.oldestQueued)}`
			: `${m.pendingDeliveries} pending deliveries`}
	/>
</div>

{#each notices as n (n.text)}
	<div
		class="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50/60 px-4 py-3 text-sm"
	>
		<TriangleAlert size={17} class="shrink-0 text-amber-600" aria-hidden="true" />
		<span class="flex-1">{n.text}</span>
		<a href={n.href} class="btn" data-sveltekit-noscroll>{n.cta}</a>
	</div>
{/each}

<div class="mt-5 grid gap-5 xl:grid-cols-[1.6fr_1fr]">
	<Card title="Jobs needing attention" flush>
		{#snippet actions()}<a href="/jobs" class="text-sm font-medium text-primary-600"
				>View all jobs →</a
			>{/snippet}
		{#if attention.length}
			<div class="table-wrap">
				<table class="table">
					<thead
						><tr
							><th>Job</th><th>Status</th><th>Last run</th><th
								><span class="sr-only">Actions</span></th
							></tr
						></thead
					>
					<tbody>
						{#each attention as j (j.name)}
							<tr>
								<td>
									<p class="font-medium">{j.label}</p>
									<p class="max-w-md truncate text-xs text-muted" title={j.lastError ?? ''}>
										{j.paused ? `Paused by ${j.pausedBy}` : j.lastError}
									</p>
								</td>
								<td
									>{#if j.paused}<Pill tone="warn">Paused</Pill>{:else}<Pill tone="bad">Failed</Pill
										>{/if}</td
								>
								<td class="text-muted"><Time at={j.lastStartedAt} /></td>
								<td class="text-right">
									<a class="btn" href="/jobs?job={j.name}" aria-label="View history for {j.label}"
										>History</a
									>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else if unreported.length === data.jobs.length}
			<Empty
				title="No job runs reported yet"
				body="The worker hasn’t recorded any runs. Start or restart it; health shows here after the first run."
			/>
		{:else}
			<Empty
				title="No paused or failing jobs"
				body={unreported.length
					? `${unreported.length} job${unreported.length === 1 ? ' hasn’t' : 's haven’t'} run yet (${unreported.map((j) => j.label).join(', ')}).`
					: 'Every job’s last run succeeded.'}
			/>
		{/if}
	</Card>

	<Card title="Service health">
		<ul class="-my-3 divide-y divide-line">
			{#each data.services as s (s.id)}
				<li>
					<a
						href="?service={s.id}"
						data-sveltekit-noscroll
						class="-mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-3 hover:bg-canvas"
					>
						<span>
							<span class="block text-sm font-medium">{s.name}</span>
							<span class="block text-xs text-muted">{s.detail}</span>
						</span>
						<Pill tone={healthTone[s.health]}>{healthText[s.health]}</Pill>
					</a>
				</li>
			{/each}
		</ul>
	</Card>
</div>

<div class="mt-5">
	<Card title="Recent admin activity" flush>
		{#snippet actions()}<a href="/audit" class="text-sm font-medium text-primary-600"
				>View audit log →</a
			>{/snippet}
		{#if data.activity.length}
			<ul class="divide-y divide-line border-t border-line">
				{#each data.activity as a (a.id)}
					<li class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-3 text-sm">
						<span>
							<span class="font-medium">{a.actorEmail}</span>
							<span class="text-muted">·</span>
							<span>{actionLabel(a.action)}</span>
							{#if a.targetLabel}<span class="text-muted">→ {a.targetLabel}</span>{/if}
						</span>
						<span class="text-xs text-muted"><Time at={a.createdAt} /></span>
					</li>
				{/each}
			</ul>
		{:else}
			<Empty title="No admin activity yet" body="Changes made in this panel appear here." />
		{/if}
	</Card>
</div>

<Drawer param="service" title={selected?.name ?? 'Service'}>
	{#if selected}
		<Pill tone={healthTone[selected.health]}>{healthText[selected.health]}</Pill>
		<dl class="mt-3">
			<div class="detail">
				<dt>Status</dt>
				<dd>{selected.detail}</dd>
			</div>
			{#if selected.advice}
				<div class="detail">
					<dt>What to check</dt>
					<dd>{selected.advice}</dd>
				</div>
			{/if}
			<div class="detail">
				<dt>{selected.id === 'web' ? 'Probed URL' : 'Instance'}</dt>
				<dd class="font-mono text-xs break-all">{selected.instance ?? '—'}</dd>
			</div>
			{#if selected.id !== 'web'}
				<div class="detail">
					<dt>Process started</dt>
					<dd><Time at={selected.startedAt} full /></dd>
				</div>
				<div class="detail">
					<dt>Last heartbeat</dt>
					<dd><Time at={selected.beatAt} full /> (<Time at={selected.beatAt} />)</dd>
				</div>
			{/if}
			{#each Object.entries(selected.meta) as [k, v] (k)}
				<div class="detail">
					<dt class="capitalize">{k.replace(/([A-Z])/g, ' $1')}</dt>
					<dd>{String(v)}</dd>
				</div>
			{/each}
		</dl>
		<p class="mt-4 text-xs text-muted">
			{selected.id === 'web'
				? 'Checked on every refresh by requesting a static asset from the web app.'
				: 'Processes report every 15 seconds; no report for 45 seconds counts as down.'}
		</p>
	{/if}
</Drawer>
