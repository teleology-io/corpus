<script lang="ts">
	import Card from '#lib/components/Card.svelte';
	import Empty from '#lib/components/Empty.svelte';
	import Time from '#lib/components/Time.svelte';
	import { actionLabel } from '#lib/audit.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const href = (params: Record<string, string | null>) => {
		const q = Object.entries(params)
			.filter(([, v]) => v)
			.map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
			.join('&');
		return q ? `?${q}` : '/audit';
	};
</script>

<Card flush>
	<div class="flex flex-wrap items-center gap-1.5 p-4 text-sm">
		<nav class="flex flex-wrap gap-1.5" aria-label="Filter by area">
			{#each [['', 'All'], ...data.filters] as [id, text] (id)}
				<a
					href={href({ action: id })}
					aria-current={data.action === id ? 'page' : undefined}
					class="rounded-full border border-line px-3 py-1 aria-[current=page]:border-primary-300 aria-[current=page]:bg-primary-50 aria-[current=page]:text-primary-700"
					>{text}</a
				>
			{/each}
		</nav>
		<span class="ml-auto text-xs text-muted">
			{data.before ? 'Older entries' : 'Newest first'} · times shown in
			<span class="font-medium">{tz}</span>
		</span>
	</div>
	{#if data.rows.length}
		<div class="table-wrap">
			<table class="table">
				<thead
					><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Reason</th></tr></thead
				>
				<tbody>
					{#each data.rows as r (r.id)}
						<tr>
							<td class="whitespace-nowrap text-muted"><Time at={r.createdAt} full /></td>
							<td>{r.actorEmail}</td>
							<td>
								<p class="font-medium">{actionLabel(r.action)}</p>
								<code class="text-xs text-muted">{r.action}</code>
							</td>
							<td>{r.targetLabel ?? r.targetId ?? '—'}</td>
							<td class="max-w-80 text-muted">{r.reason ?? '—'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<footer class="flex items-center justify-between gap-3 border-t border-line px-5 py-3 text-sm">
			{#if data.before}
				<a class="btn" href={href({ action: data.action })}>← Newest</a>
			{:else}<span></span>{/if}
			{#if data.older}
				<a class="btn" href={href({ action: data.action, before: data.older })}>Older entries →</a>
			{:else}
				<span class="text-xs text-muted">End of the audit log</span>
			{/if}
		</footer>
	{:else if data.action || data.before}
		<Empty title="No entries match" body="Nothing recorded for this filter.">
			<a class="btn" href="/audit">Clear filters</a>
		</Empty>
	{:else}
		<Empty title="No audit entries yet" body="Every change made in this panel is recorded here." />
	{/if}
</Card>
