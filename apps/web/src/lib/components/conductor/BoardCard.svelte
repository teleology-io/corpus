<script lang="ts">
	import { formatDistanceToNowStrict } from 'date-fns';
	import { GitPullRequest, MessageSquare } from '@lucide/svelte';
	import BrandIcon from '#lib/components/ui/BrandIcon.svelte';
	import type { ConductorCard } from './types';

	let {
		card,
		active = false,
		onopen
	}: { card: ConductorCard; active?: boolean; onopen: () => void } = $props();

	const status = $derived.by(() => {
		if (card.kind === 'review') {
			const s = card.review?.status;
			if (card.review?.approvedUrl) return { label: 'Approved', tone: 'ok' };
			if (card.review?.postedUrl) return { label: 'Posted', tone: 'ok' };
			if (s === 'running') return { label: 'Reviewing', tone: 'busy' };
			if (s === 'findings' || s === 'partial')
				return { label: `${card.review!.findings} findings`, tone: 'warn' };
			if (s === 'clean') return { label: 'Clean', tone: 'ok' };
			if (s === 'failed' || s === 'interrupted') return { label: 'Review failed', tone: 'bad' };
			return { label: 'Review requested', tone: 'idle' };
		}
		if (card.column === 'working') {
			if (card.blocked) return { label: 'Needs you', tone: 'bad' };
			if (card.opening) return { label: 'Opening PR', tone: 'busy' };
			if (card.prUrl && !card.agentRunning) return { label: 'Waiting on CI', tone: 'busy' };
		}
		return {
			inbox: { label: 'Not planned', tone: 'idle' },
			today: { label: 'Today', tone: 'idle' },
			working: { label: 'Working', tone: 'busy' },
			ready: { label: 'Ready', tone: 'ok' },
			done: { label: 'Shipped', tone: 'ok' }
		}[card.column];
	});
	const TONE: Record<string, string> = {
		ok: 'bg-emerald-50 text-emerald-700',
		busy: 'bg-primary-50 text-primary-700',
		warn: 'bg-amber-50 text-amber-800',
		bad: 'bg-red-50 text-red-700',
		idle: 'bg-canvas text-muted'
	};
</script>

<article class="space-y-1.5 card p-3 {active ? 'ring-2 ring-primary-400' : ''}">
	<div class="flex items-center gap-2 text-xs text-muted">
		<span class="flex min-w-0 items-center gap-1.5 font-semibold"
			><BrandIcon name={card.provider} class="size-3.5 shrink-0" /><span class="truncate"
				>{card.ref ?? (card.kind === 'review' ? 'PR' : 'Ticket')}</span
			></span
		>
	</div>
	<button
		class="block text-left text-sm leading-snug font-semibold hover:text-primary-600"
		onclick={onopen}>{card.title}</button
	>
	{#if card.subtitle}<p class="truncate text-xs text-muted">{card.subtitle}</p>{/if}
	<div class="flex items-center justify-between gap-1">
		<span class="chip inline-flex {TONE[status.tone]}">{status.label}</span><span
			class="text-[11px] text-muted"
			>{formatDistanceToNowStrict(new Date(card.movedAt), { addSuffix: true })}</span
		>
	</div>
	{#if card.chatId || card.prUrl || card.kind === 'review'}
		<div
			class="flex flex-wrap items-center gap-3 border-t border-line pt-2 text-xs font-medium text-primary-600"
		>
			{#if card.chatId && !card.chatGone}<a
					href="/workbench?{new URLSearchParams({
						...(card.workspaceId ? { workspace: card.workspaceId } : {}),
						chat: card.chatId
					})}"
					class="flex items-center gap-1"><MessageSquare class="size-3.5" /> Agent chat</a
				>{/if}
			{#if card.prUrl || card.kind === 'review'}<a
					href={card.prUrl ?? card.url}
					target="_blank"
					rel="noreferrer"
					class="flex items-center gap-1"><GitPullRequest class="size-3.5" /> PR</a
				>{/if}
		</div>
	{/if}
</article>
