<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { invalidate } from '$app/navigation';
	import { ArrowLeft, Hash, Lock, LoaderCircle, RefreshCw, User, Users } from '@lucide/svelte';
	import EmptyState from '#lib/components/ui/EmptyState.svelte';
	import { api } from '#lib/api.js';
	import { toast } from '#lib/stores/toast.svelte.js';
	import type { SlackConversationDTO, SlackMessageDTO, SlackMessagesPage } from '#lib/types.js';
	import SlackComposer from './SlackComposer.svelte';
	import SlackMessageItem from './SlackMessageItem.svelte';
	import { startPoller } from './poller.js';

	let {
		conversation,
		focusTs = null,
		onthread,
		onback
	}: {
		conversation: SlackConversationDTO;
		/** Scroll to and highlight this message (from search) */
		focusTs?: string | null;
		onthread: (ts: string) => void;
		onback: () => void;
	} = $props();

	/** Active conversation cadence; Slack's Retry-After or the 1/min limit stretch it. */
	const POLL_MS = 10_000;

	let messages = $state<SlackMessageDTO[]>([]);
	let hasOlder = $state(false);
	let loading = $state(true);
	let loadingOlder = $state(false);
	let error = $state<string | null>(null);
	let restricted = $state(false);
	let scroller = $state<HTMLDivElement>();
	let now = $state(new Date());
	let highlight = $state<string | null>(null);
	let syncedAt = '';
	/**
	 * Newest ts the server has synced for us. Only poll responses move it — a message we just sent
	 * may be newer than others' messages that haven't been synced yet.
	 */
	let since: string | null = null;
	let poller: ReturnType<typeof startPoller> | null = null;

	onMount(() => {
		const t = setInterval(() => (now = new Date()), 30_000);
		return () => clearInterval(t);
	});

	const base = $derived(`/api/slack/conversations/${conversation.id}/messages`);
	const newest = (list: SlackMessageDTO[], start: string | null) =>
		list.reduce<string | null>((max, m) => (Number(m.ts) > Number(max ?? 0) ? m.ts : max), start);
	const nearBottom = () =>
		!scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
	const toBottom = async () => {
		await tick();
		scroller?.scrollTo({ top: scroller.scrollHeight });
	};

	/** Merge by ts (dedupe), keep ascending order. */
	function merge(list: SlackMessageDTO[], incoming: SlackMessageDTO[]) {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local scratch map, never rendered
		const map = new Map(list.map((m) => [m.ts, m]));
		for (const m of incoming) map.set(m.ts, m);
		return [...map.values()].sort((a, b) => Number(a.ts) - Number(b.ts));
	}

	// (Re)load when switching conversations.
	$effect(() => {
		const id = conversation.id;
		untrack(() => void open(id));
		return () => {
			poller?.stop();
			poller = null;
		};
	});

	async function open(id: string) {
		poller?.stop();
		messages = [];
		since = null;
		error = null;
		loading = true;
		highlight = null;
		try {
			const res = await api<SlackMessagesPage>(base);
			if (conversation.id !== id) return;
			apply(res);
			messages = res.messages;
			since = newest(res.messages, null);
			hasOlder = res.hasOlder;
			// Opening marked it read: refresh the list dot and the nav dot.
			if (conversation.unread)
				void Promise.all([invalidate('app:slack'), invalidate('app:slack-unread')]);
			await (focusTs ? focus(focusTs) : toBottom());
		} catch (e) {
			error = (e as Error).message;
		} finally {
			loading = false;
		}
		if (conversation.id === id) poller = startPoller(() => poll(id), POLL_MS);
	}

	function apply(res: SlackMessagesPage) {
		error = res.error;
		restricted = res.restricted;
		syncedAt = res.syncedAt;
	}

	/** Incremental poll: new messages after the newest shown, plus edits/deletes. */
	async function poll(id: string) {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- builds a request URL only
		const q = new URLSearchParams();
		if (since) q.set('since', since);
		if (syncedAt) q.set('changedSince', syncedAt);
		const res = await api<SlackMessagesPage>(`${base}?${q}`);
		if (conversation.id !== id) return null;
		apply(res);
		since = newest(res.messages, since);
		const stick = nearBottom();
		if (res.messages.length || res.changed.length) {
			messages = merge(messages, [...res.changed, ...res.messages]);
			if (stick && res.messages.length) await toBottom();
		}
		return res.retryAfterSec ?? (res.restricted ? 60 : null);
	}

	async function older() {
		if (loadingOlder || !hasOlder || !messages.length) return;
		loadingOlder = true;
		const id = conversation.id;
		try {
			const before = messages[0]!.ts;
			const res = await api<SlackMessagesPage>(`${base}?before=${before}`);
			if (conversation.id !== id) return;
			const prev = scroller ? scroller.scrollHeight - scroller.scrollTop : 0;
			messages = merge(messages, res.messages);
			hasOlder = res.hasOlder && res.messages.length > 0;
			if (res.error) error = res.error;
			else if (res.retryAfterSec && !res.messages.length)
				error = `Slack is rate limiting — try again in ${res.retryAfterSec}s`;
			await tick();
			// Keep the reading position while content grows above it.
			if (scroller) scroller.scrollTop = scroller.scrollHeight - prev;
		} catch (e) {
			error = (e as Error).message;
		} finally {
			loadingOlder = false;
		}
	}

	/** Bring a message into view, paging back a few times if needed. */
	async function focus(ts: string) {
		for (let i = 0; i < 5 && hasOlder && messages[0] && Number(messages[0].ts) > Number(ts); i++)
			await older();
		await tick();
		const el = scroller?.querySelector(`[data-ts="${CSS.escape(ts)}"]`);
		if (el) {
			highlight = ts;
			el.scrollIntoView({ block: 'center' });
			setTimeout(() => (highlight = null), 4000);
		} else await toBottom();
	}

	$effect(() => {
		const ts = focusTs;
		if (ts && !loading) untrack(() => void focus(ts));
	});

	async function send(text: string) {
		try {
			const sent = await api<SlackMessageDTO>(base, { body: { text } });
			messages = merge(messages, [sent]);
			await toBottom();
			return true;
		} catch (e) {
			toast('Could not send', { tone: 'error', body: (e as Error).message });
			return false;
		}
	}

	const Icon = $derived(
		conversation.kind === 'im'
			? User
			: conversation.kind === 'mpim'
				? Users
				: conversation.kind === 'private'
					? Lock
					: Hash
	);
	const placeholder = $derived(
		conversation.kind === 'im' || conversation.kind === 'mpim'
			? `Message ${conversation.name}`
			: `Message #${conversation.name}`
	);
</script>

<header class="flex items-center gap-2 border-b border-line px-4 py-3">
	<button class="btn-icon size-8 md:hidden" aria-label="Back" onclick={onback}
		><ArrowLeft class="size-4" /></button
	>
	<Icon class="size-4 shrink-0 text-muted" />
	<div class="min-w-0 flex-1">
		<p class="truncate text-sm font-semibold">{conversation.name}</p>
		{#if conversation.topic}<p class="truncate text-xs text-muted">{conversation.topic}</p>{/if}
	</div>
	{#if restricted}
		<span
			class="chip bg-amber-50 text-amber-800"
			title="This Slack app is limited to 1 history request per minute, so updates are slower."
			>Slow sync</span
		>
	{/if}
	<button class="btn-icon size-8" aria-label="Refresh" title="Refresh" onclick={() => poller?.now()}
		><RefreshCw class="size-3.5" /></button
	>
</header>

<div
	bind:this={scroller}
	class="min-h-0 flex-1 scrollbar-thin space-y-4 overflow-y-auto p-4"
	onscroll={() => {
		if (scroller && scroller.scrollTop < 60 && !loading) void older();
	}}
>
	{#if hasOlder && messages.length}
		<div class="flex justify-center">
			<button class="btn-ghost h-7 text-xs" disabled={loadingOlder} onclick={older}>
				{#if loadingOlder}<LoaderCircle class="size-3.5 animate-spin" />{/if} Load older messages
			</button>
		</div>
	{/if}
	{#if loading}
		<p class="flex items-center gap-2 text-sm text-muted">
			<LoaderCircle class="size-4 animate-spin" /> Loading messages…
		</p>
	{/if}
	{#if error}
		<p class="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
	{/if}
	{#each messages as m (m.ts)}
		<SlackMessageItem {m} {now} highlight={highlight === m.ts} {onthread} />
	{:else}
		{#if !loading && !error}
			<EmptyState title="No messages yet" body="Say hello — it posts to Slack as you.">
				{#snippet icon()}<Icon class="size-5" />{/snippet}
			</EmptyState>
		{/if}
	{/each}
</div>

<SlackComposer
	{placeholder}
	onsend={send}
	disabled={!!conversation.inaccessible && !messages.length}
/>
