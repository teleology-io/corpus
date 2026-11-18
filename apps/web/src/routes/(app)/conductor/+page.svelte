<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidate } from '$app/navigation';
	import { formatDistanceToNowStrict } from 'date-fns';
	import {
		ChevronRight,
		ArrowRight,
		Bot,
		CalendarDays,
		CircleDot,
		ExternalLink,
		GitPullRequest,
		MessageSquare,
		Play,
		RotateCcw,
		Settings2,
		Sparkles,
		X
	} from '@lucide/svelte';
	import BoardCard from '#lib/components/conductor/BoardCard.svelte';
	import StandupSheet from '#lib/components/dashboard/StandupSheet.svelte';
	import BrandIcon from '#lib/components/ui/BrandIcon.svelte';
	import { api } from '#lib/api.js';
	import { attempt, toast } from '#lib/stores/toast.svelte.js';
	import type { ConductorCard, Column } from '#lib/components/conductor/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const COLUMNS: { id: Column; title: string }[] = [
		{ id: 'inbox', title: 'Inbox' },
		{ id: 'today', title: 'Today' },
		{ id: 'working', title: 'Agents working' },
		{ id: 'ready', title: 'Ready for you' },
		{ id: 'done', title: 'Done' }
	];

	let view = $state<'board' | 'plan'>('board');
	let selectedId = $state<string | null>(null);
	let standupOpen = $state(false);
	let note = $state('');
	let busy = $state(false);
	let picks = $state<Record<string, boolean>>({});
	let settingsOpen = $state(false);
	let repoPath = $state('');
	let readyWhen = $state<'draft_pr' | 'ci_green'>('draft_pr');

	// Agents and CI move cards on their own; keep the board current while it's open.
	onMount(() => {
		const t = setInterval(() => {
			if (document.visibilityState === 'visible') void invalidate('app:conductor');
		}, 20_000);
		return () => clearInterval(t);
	});

	const cards = $derived(data.cards as ConductorCard[]);
	const selected = $derived(cards.find((c) => c.id === selectedId) ?? null);
	const byColumn = $derived(
		Object.fromEntries(
			COLUMNS.map((c) => [c.id, cards.filter((x) => x.column === c.id)])
		) as Record<Column, ConductorCard[]>
	);
	const plannedToday = $derived(byColumn.today.some((c) => c.plannedFor === data.today));
	const candidates = $derived([...byColumn.today, ...byColumn.inbox]);

	const ago = (iso: string) => formatDistanceToNowStrict(new Date(iso), { addSuffix: true });

	function openPlan() {
		picks = Object.fromEntries(candidates.map((c) => [c.id, c.column === 'today']));
		view = 'plan';
	}

	async function post(body: Record<string, unknown>) {
		busy = true;
		try {
			return await attempt(() => api('/api/conductor', { body }).then(() => true));
		} finally {
			busy = false;
			await invalidate('app:conductor');
		}
	}

	async function confirmPlan() {
		const cardIds = candidates.filter((c) => picks[c.id]).map((c) => c.id);
		if (await post({ action: 'plan', cardIds })) {
			view = 'board';
			toast('Plan confirmed', { tone: 'success', body: `${cardIds.length} for today` });
		}
	}

	const move = (card: ConductorCard, column: Column) =>
		post({ action: 'move', cardId: card.id, column });

	// Repositories picked for the ticket about to start, by path.
	let chosen = $state<Record<string, boolean>>({});
	const chosenPaths = $derived(data.repos.filter((r) => chosen[r.path]).map((r) => r.path));
	const canStart = (c: ConductorCard) =>
		c.kind === 'ticket' && !c.chatId && (c.column === 'inbox' || c.column === 'today');

	function select(card: ConductorCard) {
		selectedId = card.id;
		note = '';
		chosen = data.repos.length === 1 ? { [data.repos[0]!.path]: true } : {};
	}

	async function start(card: ConductorCard) {
		const again = card.chatGone;
		const names = data.repos.filter((r) => chosen[r.path]).map((r) => r.name);
		if (
			await post({ action: 'start', cardId: card.id, ...(again ? {} : { repoPaths: chosenPaths }) })
		)
			toast(again ? 'Conversation relaunched' : 'Agents started', {
				tone: 'success',
				body: again ? 'Same worktrees and branches' : names.join(', ')
			});
	}

	function openSettings() {
		repoPath = data.settings.repoPath;
		readyWhen = data.settings.readyWhen;
		settingsOpen = true;
	}

	async function saveSettings() {
		if (await post({ action: 'settings', repoPath, readyWhen })) settingsOpen = false;
	}

	async function sendBack(card: ConductorCard) {
		if (!note.trim()) return;
		if (await post({ action: 'send_back', cardId: card.id, note: note.trim() })) {
			note = '';
			selectedId = null;
		}
	}

	async function ship(card: ConductorCard) {
		const pr = card.prUrl ? `\n\n${card.prUrl}` : '';
		if (!confirm(`Mark “${card.title}” as shipped? Merge the PR on GitHub first.${pr}`)) return;
		if (await move(card, 'done')) selectedId = null;
	}

	async function reviewAction(card: ConductorCard, action: 'start' | 'approve' | 'post') {
		const verb = { start: 'Start a review of', approve: 'Approve', post: 'Post findings on' }[
			action
		];
		if (action !== 'start' && !confirm(`${verb} “${card.title}” on GitHub?`)) return;
		busy = true;
		try {
			const ok = await attempt(() =>
				api('/api/wrx/external-reviews', {
					body:
						action === 'start'
							? { action, itemId: card.itemId }
							: { action, reviewId: card.review!.id }
				}).then(() => true)
			);
			if (ok) toast(action === 'start' ? 'Review started' : 'Sent to GitHub', { tone: 'success' });
		} finally {
			busy = false;
			await invalidate('app:conductor');
		}
	}

	const ACTIVITY_ICON: Record<string, string> = {
		plan_confirmed: 'bg-primary-50 text-primary-600',
		sent_back: 'bg-amber-50 text-amber-700',
		blocked: 'bg-red-50 text-red-700',
		started: 'bg-primary-50 text-primary-600',
		pr_opened: 'bg-violet-50 text-violet-700',
		pushed: 'bg-violet-50 text-violet-700',
		ready: 'bg-emerald-50 text-emerald-700',
		shipped: 'bg-emerald-50 text-emerald-700',
		moved: 'bg-canvas text-muted'
	};
</script>

<svelte:head><title>Conductor · Corpus</title></svelte:head>

<div class="space-y-6 p-4 lg:p-8">
	{#if view === 'plan'}
		<div class="mx-auto max-w-5xl space-y-5">
			<div>
				<button class="text-sm font-medium text-primary-600" onclick={() => (view = 'board')}
					>← Back to board</button
				>
				<h2 class="mt-3 text-2xl font-bold">Plan your day</h2>
				<p class="mt-1 text-muted">Draft your standup, then choose the work for today.</p>
			</div>
			<div class="grid gap-5 lg:grid-cols-[1fr_1.15fr]">
				<section class="space-y-3 card p-5">
					<div class="flex items-start justify-between">
						<div>
							<h3 class="font-semibold">Standup</h3>
							<p class="mt-1 text-xs text-muted">
								Drafted from your activity. Edit and copy it from the sheet.
							</p>
						</div>
						<Sparkles class="size-4 text-primary-500" />
					</div>
					<button class="btn-outline" onclick={() => (standupOpen = true)}
						><Sparkles class="size-4" /> Draft standup</button
					>
				</section>
				<section class="card p-5">
					<h3 class="font-semibold">Work for today</h3>
					<p class="mt-1 text-xs text-muted">Picked items move to Today when you confirm.</p>
					{#if candidates.length}
						<div class="mt-4 space-y-3">
							{#each candidates as c (c.id)}
								<label class="flex items-start gap-3 text-sm">
									<input type="checkbox" bind:checked={picks[c.id]} class="mt-1 accent-blue-600" />
									<span class="min-w-0">
										<span class="flex items-center gap-1.5 text-xs text-muted"
											><BrandIcon name={c.provider} class="size-3" />{c.ref ?? ''}
											{c.kind === 'review' ? '· Review' : ''}</span
										>
										<span class="block font-medium">{c.title}</span>
									</span>
								</label>
							{/each}
						</div>
					{:else}
						<p class="mt-4 text-sm text-muted">
							Nothing waiting. Tickets assigned to you and PRs asking for your review show up here.
						</p>
					{/if}
				</section>
			</div>
			<div class="flex justify-end">
				<button class="btn-primary" disabled={busy} onclick={confirmPlan}
					>Confirm plan <ChevronRight class="size-4" /></button
				>
			</div>
		</div>
	{:else}
		<div class="flex flex-wrap items-center justify-between gap-4">
			<div>
				<h2 class="text-2xl font-bold tracking-tight">Conductor</h2>
				<p class="mt-1 text-muted">Your day, in motion</p>
			</div>
			<div class="flex gap-2">
				<button class="btn-outline" onclick={openSettings}
					><Settings2 class="size-4" /> Settings</button
				>
				<button class="btn-primary" onclick={openPlan}
					><CalendarDays class="size-4" />
					{plannedToday ? 'Edit today’s plan' : 'Plan your day'}</button
				>
			</div>
		</div>
		{#if settingsOpen}
			<section class="max-w-2xl space-y-4 card p-5" aria-label="Conductor settings">
				<div class="flex items-start justify-between">
					<h3 class="font-semibold">Conductor settings</h3>
					<button
						class="btn-icon size-8"
						aria-label="Close settings"
						onclick={() => (settingsOpen = false)}><X class="size-4" /></button
					>
				</div>
				<label class="block text-sm font-semibold"
					>Repositories
					<input
						bind:value={repoPath}
						placeholder="~/.corpus"
						class="mt-2 w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-sm font-normal"
					/>
					<span class="mt-1 block text-xs font-normal text-muted"
						>A Git repository, or a folder of clones (e.g. ~/Desktop/repo) to choose from when you
						start a ticket. Each chosen repository gets its own worktree and branch. Empty uses
						~/.corpus.</span
					>
				</label>
				<fieldset class="text-sm">
					<legend class="font-semibold">Ready for you when</legend>
					<label class="mt-2 flex items-center gap-2"
						><input type="radio" bind:group={readyWhen} value="draft_pr" class="accent-blue-600" /> A
						draft PR is up</label
					>
					<label class="mt-1 flex items-center gap-2"
						><input type="radio" bind:group={readyWhen} value="ci_green" class="accent-blue-600" /> The
						PR is ready for review and CI passes</label
					>
				</fieldset>
				<div class="flex justify-end">
					<button class="btn-primary" disabled={busy} onclick={saveSettings}>Save</button>
				</div>
			</section>
		{/if}
		<div class="flex flex-col gap-5 2xl:flex-row">
			<div class="min-w-0 flex-1 overflow-x-auto pb-3">
				<div class="grid min-w-[1050px] grid-cols-5 gap-1.5">
					{#each COLUMNS as column (column.id)}
						<section
							aria-label={column.title}
							class="rounded-xl border border-line bg-canvas p-1.5"
						>
							<div class="flex items-center gap-2 px-1.5 py-3">
								<h3 class="text-sm font-semibold">{column.title}</h3>
								<span class="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-semibold text-muted"
									>{byColumn[column.id].length}</span
								>
							</div>
							<div class="space-y-1.5">
								{#each byColumn[column.id] as card (card.id)}
									<BoardCard {card} active={card.id === selectedId} onopen={() => select(card)} />
								{/each}
							</div>
						</section>
					{/each}
				</div>
			</div>
			<aside class="w-full shrink-0 border-line px-4 py-1 2xl:w-64 2xl:border-l">
				<div class="flex items-center gap-2">
					<h3 class="font-semibold">Activity</h3>
				</div>
				{#if data.activity.length}
					<ol class="mt-5 space-y-5">
						{#each data.activity as a (a.id)}
							<li class="flex gap-3">
								<span
									class="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full {ACTIVITY_ICON[
										a.kind
									] ?? 'bg-canvas text-muted'}"
									>{#if a.kind === 'plan_confirmed'}<CalendarDays
											class="size-3.5"
										/>{:else if a.kind === 'sent_back'}<RotateCcw
											class="size-3.5"
										/>{:else if a.kind === 'moved'}<ArrowRight class="size-3.5" />{:else}<CircleDot
											class="size-3.5"
										/>{/if}</span
								>
								<div class="min-w-0">
									{#if a.title}<p class="truncate text-xs font-semibold">{a.title}</p>{/if}
									<p class="text-xs text-muted">{a.text}</p>
									<p class="mt-0.5 text-xs text-muted">
										{a.actor === 'you' ? '' : `${a.actor} · `}{ago(a.at)}
									</p>
								</div>
							</li>
						{/each}
					</ol>
				{:else}
					<p class="mt-3 text-xs text-muted">What happens to your work shows up here.</p>
				{/if}
			</aside>
		</div>
	{/if}
</div>

{#if selected}
	<div
		class="fixed inset-0 z-30 flex justify-end bg-black/40"
		role="presentation"
		onclick={(e) => {
			if (e.target === e.currentTarget) selectedId = null;
		}}
		onkeydown={(e) => {
			if (e.key === 'Escape') selectedId = null;
		}}
	>
		<div
			role="dialog"
			aria-modal="true"
			aria-label={selected.title}
			class="flex h-full w-full max-w-lg flex-col overflow-y-auto bg-surface shadow-pop"
		>
			<div class="flex items-start justify-between gap-3 border-b border-line p-5">
				<div class="min-w-0">
					<p class="flex items-center gap-1.5 text-xs font-semibold text-muted">
						<BrandIcon name={selected.provider} class="size-3.5" />{selected.ref ?? ''}
					</p>
					<h2 class="mt-2 text-lg font-bold">{selected.title}</h2>
					<span class="mt-2 chip inline-flex bg-primary-50 text-primary-700"
						>{COLUMNS.find((c) => c.id === selected.column)?.title}</span
					>
				</div>
				<div class="flex gap-1">
					<a
						href={selected.url}
						target="_blank"
						rel="noreferrer"
						class="btn-icon size-8"
						aria-label="Open in {selected.provider}"><ExternalLink class="size-4" /></a
					>
					<button class="btn-icon size-8" aria-label="Close" onclick={() => (selectedId = null)}
						><X class="size-4" /></button
					>
				</div>
			</div>
			<div class="flex-1 space-y-4 p-5">
				{#if selected.kind === 'review'}
					<section class="card p-4">
						<h3 class="font-semibold">Review</h3>
						{#if selected.review}
							<p class="mt-2 text-sm text-muted">
								{selected.review.summary ?? `Status: ${selected.review.status}`}
							</p>
							<p class="mt-2 text-xs text-muted">
								{selected.review.findings} open {selected.review.findings === 1
									? 'finding'
									: 'findings'}
								{selected.review.approvedUrl ? '· Approved' : ''}{selected.review.postedUrl
									? '· Posted'
									: ''}
							</p>
						{:else}
							<p class="mt-2 text-sm text-muted">
								No review yet{selected.author ? ` · requested by ${selected.author}` : ''}.
							</p>
						{/if}
					</section>
					<section class="card p-4">
						<a
							href={selected.url}
							target="_blank"
							rel="noreferrer"
							class="flex items-center gap-2 text-sm font-medium text-primary-600"
							><GitPullRequest class="size-4" />{selected.subtitle ?? 'Pull request'}
							<ExternalLink class="size-3.5" /></a
						>
						<a href="/workbench" class="mt-2 block text-xs text-muted hover:text-primary-600"
							>Findings, diff and comments are in Workbench → Integration Review</a
						>
					</section>
				{:else}
					<section class="card p-4">
						<h3 class="flex items-center gap-2 font-semibold">
							<Bot class="size-4" /> Agent summary
						</h3>
						{#if selected.blocked}
							<div
								class="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-red-50 p-2.5 text-sm text-red-700"
							>
								<span>Needs you: {selected.blocked}</span>
								{#if selected.chatGone}
									<button
										class="btn-outline h-7 bg-surface text-xs"
										disabled={busy}
										onclick={() => start(selected)}
										><RotateCcw class="size-3.5" /> Relaunch conversation</button
									>
								{/if}
							</div>
						{/if}
						{#if selected.summary}
							<p class="mt-2 text-sm whitespace-pre-line text-muted">{selected.summary}</p>
						{:else}
							<p class="mt-2 text-sm text-muted">
								{selected.agentRunning
									? `${selected.agentName ?? 'The agent'} is working…`
									: selected.chatId
										? 'No summary yet.'
										: 'Agents haven’t started on this ticket.'}
							</p>
						{/if}
						{#if selected.opening}<p class="mt-2 text-xs text-primary-600">
								Pushing and opening the PR…
							</p>{/if}
						{#if selected.subtitle || selected.state}<p class="mt-2 text-xs text-muted">
								{selected.subtitle ?? selected.state}
							</p>{/if}
						{#if selected.note}<p class="mt-2 text-xs text-amber-700">
								Last sent back: {selected.note}
							</p>{/if}
					</section>
					<section class="card p-4">
						<h3 class="flex items-center gap-2 font-semibold">
							<GitPullRequest class="size-4" /> Pull request
						</h3>
						{#if selected.prs.length}
							{#each selected.prs as pr (pr.url)}
								<a
									href={pr.url}
									target="_blank"
									rel="noreferrer"
									class="mt-2 flex items-center gap-1 text-sm text-primary-600"
									>{pr.repo}#{pr.number} <ExternalLink class="size-3.5" /></a
								>
							{/each}
						{:else if selected.prUrl}
							<a
								href={selected.prUrl}
								target="_blank"
								rel="noreferrer"
								class="mt-2 flex items-center gap-1 text-sm text-primary-600"
								>{selected.prUrl.replace(/^https:\/\/github\.com\//, '')}
								<ExternalLink class="size-3.5" /></a
							>
						{:else}
							<p class="mt-2 text-sm text-muted">No PR yet.</p>
						{/if}
					</section>
					<section class="flex items-center justify-between card p-4">
						<h3 class="flex items-center gap-2 font-semibold">
							<MessageSquare class="size-4" /> Agent chat
						</h3>
						{#if selected.chatId && !selected.chatGone}
							<a
								href="/workbench?{new URLSearchParams({
									...(selected.workspaceId ? { workspace: selected.workspaceId } : {}),
									chat: selected.chatId
								})}"
								class="text-sm text-primary-600">Open conversation</a
							>
						{:else}
							<span class="text-sm text-muted">{selected.chatGone ? 'Removed' : 'Not started'}</span
							>
						{/if}
					</section>
					{#if canStart(selected)}
						<fieldset class="card p-4">
							<legend class="sr-only">Repositories</legend>
							<h3 class="font-semibold">Repositories</h3>
							<p class="mt-1 text-xs text-muted">
								Where the agents work. Each gets its own worktree and branch, and a PR if it
								changes.
							</p>
							{#if data.repos.length}
								<div class="mt-3 space-y-2">
									{#each data.repos as r (r.path)}
										<label class="flex items-center gap-2 text-sm">
											<input
												type="checkbox"
												bind:checked={chosen[r.path]}
												class="accent-blue-600"
											/>
											<span class="font-medium">{r.name}</span>
											<span class="truncate font-mono text-xs text-muted">{r.path}</span>
										</label>
									{/each}
								</div>
							{:else}
								<p class="mt-3 text-sm text-muted">
									No Git repositories in {data.settings.effectiveRepoPath}. Set the folder in
									Settings.
								</p>
							{/if}
						</fieldset>
					{:else if selected.repos.length}
						<p class="text-xs text-muted">Working in {selected.repos.join(', ')}</p>
					{/if}
					<label class="block text-sm font-semibold"
						>Add a note<textarea
							bind:value={note}
							rows="3"
							placeholder="Share feedback, request changes, or add context…"
							class="mt-2 w-full rounded-lg border border-line bg-surface p-3 text-sm font-normal"
						></textarea></label
					>
				{/if}
			</div>
			<div class="flex flex-wrap justify-end gap-2 border-t border-line p-5">
				{#if selected.kind === 'review'}
					{#if !selected.review || selected.review.status === 'failed' || selected.review.status === 'interrupted' || selected.review.status === 'stale'}
						<button
							class="btn-primary"
							disabled={busy}
							onclick={() => reviewAction(selected, 'start')}>Start review</button
						>
					{:else if selected.column === 'ready'}
						<button
							class="btn-outline"
							disabled={busy || !selected.review.findings || !!selected.review.postedUrl}
							onclick={() => reviewAction(selected, 'post')}>Post findings</button
						>
						<button
							class="btn-primary"
							disabled={busy || !!selected.review.approvedUrl}
							onclick={() => reviewAction(selected, 'approve')}>Approve review</button
						>
					{/if}
				{:else if canStart(selected)}
					<button
						class="btn-primary"
						disabled={busy || !chosenPaths.length}
						title={chosenPaths.length ? '' : 'Choose a repository'}
						onclick={() => start(selected)}><Play class="size-4" /> Start agents</button
					>
				{:else}
					<button
						class="btn-outline flex-1 justify-center"
						disabled={busy || !note.trim()}
						title={note.trim() ? '' : 'Add a note first'}
						onclick={() => sendBack(selected)}>Send back</button
					>
					<button
						class="btn-primary flex-1 justify-center"
						disabled={busy || selected.column === 'done'}
						onclick={() => ship(selected)}>Ship</button
					>
				{/if}
			</div>
		</div>
	</div>
{/if}

<StandupSheet bind:open={standupOpen} />
