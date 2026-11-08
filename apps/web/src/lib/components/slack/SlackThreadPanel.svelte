<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { LoaderCircle, X } from '@lucide/svelte';
	import { api } from '#lib/api.js';
	import { toast } from '#lib/stores/toast.svelte.js';
	import type { SlackMessageDTO } from '#lib/types.js';
	import SlackComposer from './SlackComposer.svelte';
	import SlackMessageItem from './SlackMessageItem.svelte';
	import { startPoller } from './poller.js';

	let {
		channelId,
		threadTs,
		title,
		focusTs = null,
		onclose
	}: {
		channelId: string;
		threadTs: string;
		title: string;
		focusTs?: string | null;
		onclose: () => void;
	} = $props();

	interface ThreadRes {
		messages: SlackMessageDTO[];
		retryAfterSec: number | null;
		restricted: boolean;
		error: string | null;
	}

	let messages = $state<SlackMessageDTO[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let scroller = $state<HTMLDivElement>();
	let now = $state(new Date());

	onMount(() => {
		const t = setInterval(() => (now = new Date()), 30_000);
		return () => clearInterval(t);
	});

	const url = $derived(`/api/slack/conversations/${channelId}/threads/${threadTs}`);

	$effect(() => {
		const key = url;
		let poller: ReturnType<typeof startPoller> | null = null;
		untrack(() => {
			messages = [];
			loading = true;
			void load(key, true).then(() => {
				if (key === url) poller = startPoller(() => load(key, false), 10_000);
			});
		});
		return () => poller?.stop();
	});

	async function load(key: string, first: boolean) {
		try {
			const res = await api<ThreadRes>(key);
			if (key !== url) return null;
			const stick =
				!scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
			messages = res.messages;
			error = res.error;
			await tick();
			if (first && focusTs) {
				scroller
					?.querySelector(`[data-ts="${CSS.escape(focusTs)}"]`)
					?.scrollIntoView({ block: 'center' });
			} else if (first || stick) scroller?.scrollTo({ top: scroller.scrollHeight });
			return res.retryAfterSec ?? (res.restricted ? 60 : null);
		} catch (e) {
			if (first) error = (e as Error).message;
			else throw e;
			return null;
		} finally {
			if (first) loading = false;
		}
	}

	async function send(text: string) {
		try {
			const sent = await api<SlackMessageDTO>(`/api/slack/conversations/${channelId}/messages`, {
				body: { text, threadTs }
			});
			messages = [...messages.filter((m) => m.ts !== sent.ts), sent];
			await tick();
			scroller?.scrollTo({ top: scroller.scrollHeight });
			return true;
		} catch (e) {
			toast('Could not send reply', { tone: 'error', body: (e as Error).message });
			return false;
		}
	}
</script>

<header class="flex items-center gap-2 border-b border-line px-4 py-3">
	<div class="min-w-0 flex-1">
		<p class="text-sm font-semibold">Thread</p>
		<p class="truncate text-xs text-muted">{title}</p>
	</div>
	<button class="btn-icon size-8" aria-label="Close thread" onclick={onclose}
		><X class="size-4" /></button
	>
</header>
<div bind:this={scroller} class="min-h-0 flex-1 scrollbar-thin space-y-4 overflow-y-auto p-4">
	{#if loading}
		<p class="flex items-center gap-2 text-sm text-muted">
			<LoaderCircle class="size-4 animate-spin" /> Loading thread…
		</p>
	{/if}
	{#if error}
		<p class="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
	{/if}
	{#each messages as m, i (m.ts)}
		<div class={i === 0 && messages.length > 1 ? 'border-b border-line pb-4' : ''}>
			<SlackMessageItem {m} {now} highlight={focusTs === m.ts} />
		</div>
	{/each}
</div>
<SlackComposer placeholder="Reply in thread…" onsend={send} />
