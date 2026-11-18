<script lang="ts">
	import {
		ClipboardCopy,
		ExternalLink,
		LoaderCircle,
		RefreshCw,
		Sparkles,
		TriangleAlert
	} from '@lucide/svelte';
	import Modal from '#lib/components/ui/Modal.svelte';
	import { untrack } from 'svelte';
	import { api } from '#lib/api.js';
	import { createEvidenceGate } from '#lib/standup/evidence-gate.js';
	import { toast } from '#lib/stores/toast.svelte.js';
	import { readStandupDevicePrefs } from '#lib/stores/standup-prefs.js';
	import { generateStandup, type SignedSnapshot } from '#lib/standup/generate.js';
	import {
		PLAN_GROUPS,
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

	// ----- Today checklist -----
	// The user's picks, keyed by source (not item id) so they survive Refresh evidence; they also
	// survive Compact/Verbose switches and Regenerate because nothing here resets them.
	let picks = $state<Record<string, boolean>>({});
	// Picks are remembered for the rest of the day on this device, so meetings you dropped this
	// morning stay dropped when you reopen the sheet; tomorrow starts fresh.
	const PICKS_KEY = 'corpus-standup-picks';
	const dayKey = () => new Date().toLocaleDateString('en-CA');
	function loadPicks() {
		try {
			const saved = JSON.parse(localStorage.getItem(PICKS_KEY) ?? 'null');
			if (saved?.day === dayKey() && saved.picks && typeof saved.picks === 'object')
				picks = { ...saved.picks, ...picks };
		} catch {
			/* unreadable: start fresh */
		}
	}
	$effect(() => {
		const day = dayKey();
		const saved = $state.snapshot(picks);
		try {
			localStorage.setItem(PICKS_KEY, JSON.stringify({ day, picks: saved }));
		} catch {
			/* storage unavailable: picks last until reload */
		}
	});
	loadPicks();
	let resultSelection = $state('');
	const GROUP_PREVIEW = 8;
	const sourceKey = (i: StandupItem) => `${i.source.type}:${i.source.id}`;
	const isAuto = (i: StandupItem) => i.plan === 'auto' || i.plan === undefined;
	const isPicked = (i: StandupItem) => isAuto(i) || (picks[sourceKey(i)] ?? i.plan === 'on');
	const todayItems = $derived((snapshot?.items ?? []).filter((i) => i.section === 'today'));
	const selected = $derived(todayItems.filter((i) => !isAuto(i) && isPicked(i)).map((i) => i.id));
	const pickedCount = $derived(selected.length);
	const planChanged = $derived(!!result && resultSelection !== selected.join(','));
	const planGroups = $derived(
		PLAN_GROUPS.map((g) => ({ ...g, items: todayItems.filter((i) => i.group === g.key) })).filter(
			(g) => g.items.length
		)
	);
	function setGroup(items: StandupItem[], on: boolean) {
		for (const i of items) if (!isAuto(i)) picks[sourceKey(i)] = on;
	}
	const external = (url: string) => !url.startsWith('/');
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
				selected,
				onstatus: (s) => (status = s)
			});
			resultSelection = selected.join(',');
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

	const ATTEMPT_LABEL = { liquid: 'Liquid AI', hosted: 'Hosted', template: 'Template' } as const;

	function copyDiagnostics() {
		if (!result) return;
		const report = {
			by: result.by,
			detail: result.detail,
			attempts: result.attempts,
			userAgent: navigator.userAgent,
			items: snapshot?.items.length
		};
		navigator.clipboard.writeText(JSON.stringify(report, null, 2)).then(
			() => toast('Details copied', { tone: 'success' }),
			() => toast('Could not copy details', { tone: 'error' })
		);
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

{#snippet checklist()}
	<p class="text-xs text-muted">
		Only what you check goes under Today. Checking something doesn’t start any work.
	</p>
	{#each planGroups as g (g.key)}
		{@const shown = expanded[`g:${g.key}`] ? g.items : g.items.slice(0, GROUP_PREVIEW)}
		<div class="mt-3 flex items-center justify-between gap-2">
			<p class="text-[11px] font-semibold tracking-wide text-muted uppercase">{g.label}</p>
			{#if g.items.length > 1}
				<span class="flex gap-2 text-xs">
					<button class="text-primary-600 hover:underline" onclick={() => setGroup(g.items, true)}
						>All</button
					>
					<button class="text-primary-600 hover:underline" onclick={() => setGroup(g.items, false)}
						>None</button
					>
				</span>
			{/if}
		</div>
		<ul class="mt-1 space-y-1">
			{#each shown as i (i.id)}
				<li class="flex items-start gap-2 text-sm">
					{#if isAuto(i)}
						<span class="mt-0.5 w-4 shrink-0 text-center text-muted" aria-hidden="true">•</span>
						<span class="min-w-0 flex-1">
							<span class="text-muted">{i.lead ?? VERBS[i.verb]}</span>
							<span class="font-medium">{i.title}</span>
						</span>
					{:else}
						<label class="flex min-w-0 flex-1 cursor-pointer items-start gap-2">
							<input
								type="checkbox"
								class="mt-0.5 size-4 shrink-0 accent-primary-500"
								checked={isPicked(i)}
								onchange={(e) => (picks[sourceKey(i)] = e.currentTarget.checked)}
							/>
							<span class="min-w-0">
								{#if i.group === 'meeting' && i.lead}<span class="text-muted">{i.lead}</span>
								{/if}<span class="font-medium break-words">{i.title}</span>
								{#if i.statements.length}
									<span class="block text-xs text-muted"
										>{i.statements.map((s) => s.text).join(' · ')}</span
									>
								{/if}
							</span>
						</label>
					{/if}
					{#if i.url}
						<a
							class="btn-icon size-7 shrink-0"
							href={i.url}
							target={external(i.url) ? '_blank' : undefined}
							rel="noreferrer"
							aria-label="Open {i.title}"><ExternalLink class="size-3.5" /></a
						>
					{/if}
				</li>
			{/each}
		</ul>
		{#if g.items.length > GROUP_PREVIEW}
			<button
				class="mt-1 text-xs font-medium text-primary-600 hover:underline"
				onclick={() => (expanded[`g:${g.key}`] = !expanded[`g:${g.key}`])}
			>
				{expanded[`g:${g.key}`] ? 'Show fewer' : `+${g.items.length - GROUP_PREVIEW} more`}
			</button>
		{/if}
	{:else}
		<p class="mt-2 text-sm text-muted">No meetings or open work for today.</p>
	{/each}
{/snippet}

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
		<details class="mt-4 rounded-lg border border-line px-3 py-2" open={planChanged}>
			<summary class="cursor-pointer text-sm font-medium">
				Today’s plan · {pickedCount} picked
				{#if planChanged}<span class="ml-1 text-xs font-normal text-amber-600"
						>changed — Regenerate to apply</span
					>{/if}
			</summary>
			<div class="mt-1 pb-1">{@render checklist()}</div>
		</details>
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
		<details class="mt-5 rounded-lg border border-line px-3 py-2 text-xs">
			<summary class="cursor-pointer font-medium text-muted"> How this was generated </summary>
			<ol class="mt-2 space-y-2">
				{#each result.attempts as a, n (n)}
					<li>
						<span class="font-medium text-ink">{ATTEMPT_LABEL[a.provider]}</span>
						<span
							class="ml-1 rounded px-1.5 py-0.5 {a.outcome === 'used'
								? 'bg-green-500/10 text-green-700 dark:text-green-400'
								: 'bg-amber-500/10 text-amber-700 dark:text-amber-400'}">{a.outcome}</span
						>
						{#if a.ms !== undefined}<span class="ml-1 text-muted">{(a.ms / 1000).toFixed(1)}s</span
							>{/if}
						<p class="mt-0.5 text-muted">{a.reason}</p>
						{#if a.checks}
							<p class="mt-0.5 font-mono text-[11px] text-muted">
								{Object.entries(a.checks)
									.map(([k, v]) => `${k}=${v}`)
									.join(' · ')}
							</p>
						{/if}
						{#if a.errors && a.errors.length > 1}
							<ul class="mt-0.5 list-disc pl-4 text-muted">
								{#each a.errors as e, i (i)}<li>{e}</li>{/each}
							</ul>
						{/if}
						{#if a.output}
							<pre
								class="mt-1 max-h-32 overflow-auto rounded bg-black/5 p-2 font-mono text-[11px] whitespace-pre-wrap dark:bg-white/5">{a.output}</pre>
						{/if}
					</li>
				{/each}
			</ol>
			<button
				class="mt-2 text-xs font-medium text-primary-600 hover:underline"
				onclick={copyDiagnostics}>Copy details</button
			>
		</details>
	{:else if snapshot}
		<section class="mt-4">
			<h3 class="text-sm font-semibold text-ink">What do you plan to work on today?</h3>
			{@render checklist()}
		</section>
		<p class="mt-4 text-xs text-muted">
			Then pick Compact or Verbose and Generate. Both use the same evidence; Verbose adds context
			from it, never new facts.
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
