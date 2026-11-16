<script lang="ts">
	import { ClipboardCopy, LoaderCircle, RefreshCw, Sparkles, TriangleAlert } from '@lucide/svelte';
	import Modal from '#lib/components/ui/Modal.svelte';
	import { untrack } from 'svelte';
	import { api } from '#lib/api.js';
	import { createEvidenceGate } from '#lib/standup/evidence-gate.js';
	import { toast } from '#lib/stores/toast.svelte.js';
	import { readStandupDevicePrefs } from '#lib/stores/standup-prefs.js';
	import { generateStandup, type SignedSnapshot } from '#lib/standup/generate.js';
	import {
		VERBS,
		VISIBLE_PER_SECTION,
		type Detail,
		type StandupItem,
		type StandupResult,
		type StandupSnapshot
	} from '#lib/standup/model.js';

	let {
		open = $bindable(false),
		detail = $bindable<Detail>('compact')
	}: {
		open?: boolean;
		detail?: Detail;
	} = $props();

	let signed = $state<SignedSnapshot | null>(null);
	let snapshot = $state<StandupSnapshot | null>(null);
	let loadingEvidence = $state(false);
	let evidenceError = $state<string | null>(null);
	let generating = $state(false);
	let status = $state('');
	let generateError = $state<string | null>(null);
	let result = $state<StandupResult | null>(null);
	let markdown = $state('');
	let tab = $state<'preview' | 'markdown'>('preview');
	let expanded = $state<Record<string, boolean>>({});

	const edited = $derived(!!result && markdown !== result.markdown);
	const byId = $derived(new Map((snapshot?.items ?? []).map((i) => [i.id, i])));
	const missing = $derived((snapshot?.coverage ?? []).filter((c) => c.status !== 'included'));

	async function loadEvidence() {
		loadingEvidence = true;
		evidenceError = null;
		try {
			const s = await api<SignedSnapshot>('/api/standup');
			signed = s;
			snapshot = JSON.parse(s.payload) as StandupSnapshot;
			result = null;
			markdown = '';
		} catch (e) {
			evidenceError = (e as Error).message;
		} finally {
			loadingEvidence = false;
		}
	}

	// Depends on `open` only, so a failed request can't re-trigger itself.
	const gate = createEvidenceGate();
	$effect(() => {
		const isOpen = open;
		untrack(() => {
			if (gate.opened(isOpen, snapshot?.expiresAt ?? null)) void loadEvidence();
		});
	});

	function setDetail(d: Detail) {
		if (d === detail) return;
		detail = d;
		// Remembered per user so it follows across devices. A failed save only loses the memory.
		api('/api/settings', { method: 'PATCH', body: { key: 'standup.detail', value: d } }).catch(
			() => {}
		);
	}

	async function generate() {
		if (!snapshot || !signed) return;
		if (Date.parse(snapshot.expiresAt) <= Date.now()) {
			evidenceError = 'Evidence expired. Refresh it before generating.';
			return;
		}
		generating = true;
		generateError = null;
		status = 'Preparing…';
		try {
			const r = await generateStandup({
				snapshot,
				signed,
				detail,
				pref: readStandupDevicePrefs().provider,
				onstatus: (s) => (status = s)
			});
			result = r;
			markdown = r.markdown;
			expanded = {};
		} catch (e) {
			generateError = `Couldn’t generate the standup: ${(e as Error).message || 'unknown error'}`;
		} finally {
			generating = false;
			status = '';
		}
	}

	function copy() {
		// No await before the write: iOS Safari needs it inside the tap's user gesture.
		navigator.clipboard.writeText(markdown).then(
			() => toast('Standup copied as Markdown', { tone: 'success' }),
			() => toast('Could not copy. Select the Markdown tab text instead.', { tone: 'error' })
		);
	}

	const sections = $derived(
		result
			? (['past', 'today'] as const).map((s) => ({
					key: s,
					heading: s === 'past' ? snapshot!.window.label : 'Today',
					entries: result!.plan[s]
						.map((e) => ({ item: byId.get(e.id)!, statements: e.statements }))
						.filter((e) => e.item)
				}))
			: []
	);
	const statementText = (item: StandupItem, keys: string[]) =>
		keys
			.map((k) => item.statements.find((s) => s.key === k)?.text)
			.filter(Boolean)
			.join('; ');
</script>

<Modal bind:open title="Standup" size="lg" fullscreenOnMobile>
	{#snippet icon()}<Sparkles class="size-5" />{/snippet}

	<div class="flex flex-wrap items-center gap-2">
		<div
			class="inline-flex rounded-lg border border-line p-0.5"
			role="radiogroup"
			aria-label="Detail"
		>
			{#each [['compact', 'Compact'], ['verbose', 'Verbose']] as [value, label] (value)}
				<button
					type="button"
					role="radio"
					aria-checked={detail === value}
					class="h-8 rounded-md px-3 text-sm font-medium {detail === value
						? 'bg-primary-500 text-white'
						: 'text-muted hover:text-ink'}"
					onclick={() => setDetail(value as Detail)}
					disabled={generating}>{label}</button
				>
			{/each}
		</div>
		<button
			class="btn-primary h-9 flex-1 justify-center sm:flex-none"
			onclick={generate}
			disabled={!snapshot || generating || loadingEvidence}
		>
			{#if generating}<LoaderCircle class="size-4 animate-spin" />{:else}<Sparkles
					class="size-4"
				/>{/if}
			{result ? 'Regenerate' : 'Generate'}
		</button>
		<button
			class="btn-outline h-9 px-3 sm:ml-auto"
			onclick={loadEvidence}
			disabled={loadingEvidence || generating}
			title="Collect activity again"
		>
			<RefreshCw class="size-4 {loadingEvidence ? 'animate-spin' : ''}" />
			<span class="max-sm:sr-only">Refresh evidence</span>
		</button>
	</div>

	{#if snapshot}
		<p class="mt-2 text-xs text-muted">
			{snapshot.window.label}: {new Date(snapshot.window.from).toLocaleDateString(undefined, {
				timeZone: snapshot.timezone,
				weekday: 'short',
				month: 'short',
				day: 'numeric'
			})} – today · {snapshot.items.length} items of evidence
		</p>
	{/if}
	{#if missing.length}
		<p class="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted">
			<TriangleAlert class="size-3.5 text-amber-500" /> Not covered:
			{#each missing as c (c.source + c.label)}
				<span class="rounded-full border border-line px-2 py-0.5"
					>{c.label}{c.status === 'not_connected'
						? ' (not connected)'
						: c.note
							? ` (${c.note})`
							: ''}</span
				>
			{/each}
		</p>
	{/if}

	{#if evidenceError}
		<p class="mt-4 text-sm text-red-600">{evidenceError}</p>
		<button class="mt-2 btn-outline h-8 px-3 text-sm" onclick={loadEvidence}>Try again</button>
	{:else if loadingEvidence}
		<p class="mt-4 flex items-center gap-2 text-sm text-muted">
			<LoaderCircle class="size-4 animate-spin" /> Collecting activity…
		</p>
	{:else if generating}
		<p class="mt-4 flex items-center gap-2 text-sm text-muted">
			<LoaderCircle class="size-4 animate-spin" />
			{status}
		</p>
	{:else if generateError && !result}
		<p class="mt-4 text-sm text-red-600">{generateError}</p>
	{:else if result}
		{#if generateError}<p class="mt-4 text-sm text-red-600">{generateError}</p>{/if}
		<div class="mt-4 flex gap-1 border-b border-line text-sm">
			{#each [['preview', 'Preview'], ['markdown', 'Markdown']] as [value, label] (value)}
				<button
					class="-mb-px border-b-2 px-3 py-1.5 font-medium {tab === value
						? 'border-primary-500 text-ink'
						: 'border-transparent text-muted'}"
					onclick={() => (tab = value as typeof tab)}>{label}</button
				>
			{/each}
		</div>
		{#if tab === 'preview'}
			{#if edited}
				<p class="mt-3 text-xs text-muted">
					You edited the Markdown. Preview shows the generated version; Copy uses your edit.
				</p>
			{/if}
			{#each sections as s (s.key)}
				<h3 class="mt-4 text-sm font-semibold text-ink">{s.heading}</h3>
				{#if !s.entries.length}
					<p class="mt-1 text-sm text-muted">Nothing recorded.</p>
				{:else}
					{@const shown = expanded[s.key] ? s.entries : s.entries.slice(0, VISIBLE_PER_SECTION)}
					<ul class="mt-1 space-y-1.5 text-sm">
						{#each shown as { item, statements } (item.id)}
							<li class="leading-snug">
								<span class="text-muted">{item.lead ?? VERBS[item.verb]}:</span>
								{#if item.url}<a
										class="font-medium text-primary-600 hover:underline"
										href={item.url}
										target={item.url.startsWith('/') ? undefined : '_blank'}
										rel="noreferrer">{item.title}</a
									>{:else}<span class="font-medium">{item.title}</span>{/if}
								{#each item.related as r (r.url)}
									<a
										class="ml-1 text-xs text-primary-600 hover:underline"
										href={r.url}
										target={r.url.startsWith('/') ? undefined : '_blank'}
										rel="noreferrer">({r.label})</a
									>
								{/each}
								{#if statements.length}<span class="text-muted">
										— {statementText(item, statements)}</span
									>{/if}
							</li>
						{/each}
					</ul>
					{#if s.entries.length > VISIBLE_PER_SECTION}
						<button
							class="mt-1.5 text-xs font-medium text-primary-600 hover:underline"
							onclick={() => (expanded[s.key] = !expanded[s.key])}
						>
							{expanded[s.key] ? 'Show fewer' : `+${s.entries.length - VISIBLE_PER_SECTION} more`}
						</button>
					{/if}
				{/if}
			{/each}
		{:else}
			<textarea
				class="mt-3 input min-h-64 w-full font-mono text-sm max-sm:min-h-[50dvh]"
				bind:value={markdown}
				aria-label="Standup Markdown"></textarea>
		{/if}
	{:else if snapshot}
		<p class="mt-4 text-sm text-muted">
			Pick Compact or Verbose, then Generate. Both use the same evidence; Verbose adds context from
			it, never new facts.
		</p>
	{/if}

	{#snippet footer()}
		<p class="line-clamp-2 min-w-0 flex-1 text-xs text-muted" title={result?.note}>
			{#if result}{result.detail === 'verbose' ? 'Verbose' : 'Compact'} · {result.note}{/if}
		</p>
		<button class="btn-outline h-9" onclick={copy} disabled={!result || !markdown}>
			<ClipboardCopy class="size-4" /> Copy Markdown
		</button>
	{/snippet}
</Modal>
