<script lang="ts">
	import ActionButton from '#lib/components/ActionButton.svelte';
	import Card from '#lib/components/Card.svelte';
	import Drawer from '#lib/components/Drawer.svelte';
	import Empty from '#lib/components/Empty.svelte';
	import Pill, { type Tone } from '#lib/components/Pill.svelte';
	import Time from '#lib/components/Time.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const label = (p: string) => p.charAt(0).toUpperCase() + p.slice(1);
	function summary(p: (typeof data.providers)[number]): [string, Tone] {
		if (p.errored) return [`${p.errored} in error`, 'bad'];
		if (p.rateLimited || p.failing) return ['Degraded', 'warn'];
		return ['Healthy', 'ok'];
	}
	const statusTone: Record<string, Tone> = { active: 'ok', error: 'bad', revoked: 'neutral' };

	// Connection drawer filters (client-side: one provider's connections are a short list).
	type Filter = 'all' | 'problems' | 'rate-limited';
	let query = $state('');
	let filter = $state<Filter>('all');
	$effect(() => {
		void data.provider;
		query = '';
		filter = 'all';
	});
	const shown = $derived(
		(data.connections ?? []).filter((c) => {
			const q = query.trim().toLowerCase();
			if (q && !`${c.userEmail} ${c.accountLogin ?? ''}`.toLowerCase().includes(q)) return false;
			if (filter === 'problems') return c.status === 'error' || c.failureCount > 0;
			if (filter === 'rate-limited') return !!c.blockedUntil;
			return true;
		})
	);
	const filters: [Filter, string][] = [
		['all', 'All'],
		['problems', 'Errors & retrying'],
		['rate-limited', 'Rate limited']
	];
</script>

{#if data.providers.length}
	<div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
		{#each data.providers as p (p.provider)}
			{@const [text, tone] = summary(p)}
			<Card title={label(p.provider)}>
				{#snippet actions()}<Pill {tone}>{text}</Pill>{/snippet}
				<dl class="grid grid-cols-3 gap-x-2 gap-y-3 text-sm">
					<div>
						<dt class="text-xs text-muted">Connections</dt>
						<dd class="font-semibold">{p.total}</dd>
					</div>
					<div>
						<dt class="text-xs text-muted">Active</dt>
						<dd class="font-semibold">{p.active}</dd>
					</div>
					<div>
						<dt class="text-xs text-muted">Errors</dt>
						<dd class="font-semibold {p.errored ? 'text-red-600' : ''}">{p.errored}</dd>
					</div>
					<div>
						<dt class="text-xs text-muted">Retrying</dt>
						<dd class="font-semibold {p.failing ? 'text-amber-600' : ''}">{p.failing}</dd>
					</div>
					<div>
						<dt class="text-xs text-muted">Rate limited</dt>
						<dd class="font-semibold {p.rateLimited ? 'text-amber-600' : ''}">{p.rateLimited}</dd>
					</div>
					<div>
						<dt class="text-xs text-muted">Revoked</dt>
						<dd class="font-semibold">{p.revoked}</dd>
					</div>
				</dl>
				<p class="mt-4 text-xs text-muted">Last polled <Time at={p.lastPolledAt} /></p>
				<a class="mt-4 btn" href="?provider={p.provider}" data-sveltekit-noscroll
					>Inspect connections</a
				>
			</Card>
		{/each}
	</div>
{:else}
	<Card>
		<Empty
			title="No integrations connected"
			body="Connections appear here once a user links GitHub, Linear, Slack or Google."
		/>
	</Card>
{/if}

<Drawer param="provider" title="{label(data.provider ?? '')} connections">
	{#if data.connections?.length}
		<div class="space-y-3">
			<input
				type="search"
				class="input w-full"
				placeholder="Find by user email or account"
				aria-label="Find a connection"
				bind:value={query}
			/>
			<div class="flex flex-wrap gap-1.5 text-xs" role="group" aria-label="Filter connections">
				{#each filters as [value, text] (value)}
					<button
						type="button"
						aria-pressed={filter === value}
						onclick={() => (filter = value)}
						class="rounded-full border border-line px-2.5 py-1 aria-pressed:border-primary-300 aria-pressed:bg-primary-50 aria-pressed:text-primary-700"
					>
						{text}
					</button>
				{/each}
			</div>
			<p class="text-xs text-muted" aria-live="polite">
				Showing {shown.length} of {data.connections.length} · tokens are never shown here
			</p>
		</div>
		{#if shown.length}
			<ul class="mt-2 divide-y divide-line">
				{#each shown as c (c.id)}
					<li class="py-4 text-sm">
						<div class="flex items-start justify-between gap-3">
							<div class="min-w-0">
								<p class="truncate font-medium">{c.userEmail}</p>
								<p class="text-xs text-muted">
									{c.accountLogin ?? '—'} · {c.authType} · polled <Time at={c.lastPolledAt} />
								</p>
							</div>
							<div class="flex shrink-0 items-center gap-1.5">
								{#if c.blockedUntil}<Pill tone="warn">Rate limited</Pill>{/if}
								<Pill tone={statusTone[c.status] ?? 'neutral'}>{c.status}</Pill>
							</div>
						</div>
						{#if c.lastError}
							<p class="mt-2 font-mono text-xs break-all text-red-700">{c.lastError}</p>
						{/if}
						<p class="mt-2 text-xs text-muted">
							{#if c.failureCount}{c.failureCount} consecutive failures ·
							{/if}
							{#if c.blockedUntil}
								Provider rate limit lifts <Time at={c.blockedUntil} />. Retry polls now, but calls
								to the provider still wait until then.
							{:else if c.status !== 'revoked'}
								Next poll <Time at={c.nextPollAt} />.
							{:else}
								Revoked by the user; they must reconnect it in Corpus.
							{/if}
						</p>
						{#if c.status !== 'revoked'}
							<div class="mt-2">
								<ActionButton
									action="?/retry"
									fields={{ id: c.id }}
									label="Retry {c.userEmail} now"
									success="Retry queued for {c.userEmail}. Backoff cleared; the worker polls it within seconds."
								>
									Retry now
								</ActionButton>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<Empty title="No matching connections" body="Try another search or filter.">
				<button type="button" class="btn" onclick={() => ((query = ''), (filter = 'all'))}
					>Clear filters</button
				>
			</Empty>
		{/if}
	{:else}
		<Empty title="No connections" body="Nobody has connected this provider." />
	{/if}
</Drawer>
