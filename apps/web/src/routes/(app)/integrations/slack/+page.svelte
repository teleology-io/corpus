<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { goto, refreshAll } from '$app/navigation';
	import { formatDistanceToNowStrict, format } from 'date-fns';
	import {
		ArrowLeft,
		AtSign,
		BellOff,
		ExternalLink,
		Link2,
		LoaderCircle,
		MessagesSquare,
		Paperclip,
		SendHorizontal
	} from '@lucide/svelte';
	import BrandIcon from '#lib/components/ui/BrandIcon.svelte';
	import Avatar from '#lib/components/ui/Avatar.svelte';
	import EmptyState from '#lib/components/ui/EmptyState.svelte';
	import SlackText from '#lib/components/slack/SlackText.svelte';
	import { api } from '#lib/api.js';
	import { attempt, toast } from '#lib/stores/toast.svelte.js';
	import type { SlackMessageDTO, SlackThreadDTO } from '#lib/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let filter = $state<'all' | 'unread' | 'mentions'>('all');
	let link = $state('');
	let following = $state(false);
	let messages = $state<SlackMessageDTO[]>([]);
	let loading = $state(false);
	let loadError = $state<string | null>(null);
	let draft = $state('');
	let sending = $state(false);
	let scroller = $state<HTMLDivElement>();
	let now = $state(new Date());

	onMount(() => {
		const t = setInterval(() => (now = new Date()), 30_000);
		return () => clearInterval(t);
	});

	const threads = $derived(
		data.threads.filter((t) =>
			filter === 'unread' ? t.unread : filter === 'mentions' ? t.mentioned : true
		)
	);
	const current = $derived(data.threads.find((t) => t.id === data.selected) ?? null);

	// Reload the open thread when switching threads or when live polling sees new activity.
	let loadedKey = '';
	$effect(() => {
		const key = current ? `${current.id}:${current.lastActivityAt}` : '';
		if (!current || key === loadedKey) return;
		const switching = !loadedKey.startsWith(current.id);
		loadedKey = key;
		void load(current.id, switching);
	});

	async function load(id: string, switching: boolean) {
		if (switching) {
			messages = [];
			loading = true;
		}
		loadError = null;
		try {
			const res = await api<{ thread: SlackThreadDTO; messages: SlackMessageDTO[] }>(
				`/api/slack/threads/${id}`
			);
			if (data.selected !== id) return;
			messages = res.messages;
			// Opening marked it read; let the list (and its unread dot) catch up.
			if (current?.unread) void refreshAll();
			await tick();
			scroller?.scrollTo({ top: scroller.scrollHeight });
		} catch (e) {
			loadError = (e as Error).message;
		} finally {
			loading = false;
		}
	}

	function open(id: string | null) {
		goto(id ? `?thread=${id}` : '?', { replace: true, reset: false });
	}

	async function follow(e: SubmitEvent) {
		e.preventDefault();
		if (!link.trim()) return;
		following = true;
		const res = await attempt(() => api<{ id: string }>('/api/slack/threads', { body: { link } }));
		following = false;
		if (!res) return;
		link = '';
		await goto(`?thread=${res.id}`, { replace: true, refreshAll: true, reset: false });
	}

	async function send() {
		const text = draft.trim();
		if (!text || !current || sending) return;
		sending = true;
		const ok = await attempt(
			() => api(`/api/slack/threads/${current!.id}/reply`, { body: { text } }).then(() => true),
			'Could not send reply'
		);
		sending = false;
		if (!ok) return;
		draft = '';
		await load(current.id, false);
		await refreshAll();
	}

	async function unfollow() {
		if (!current) return;
		await attempt(() =>
			api(`/api/slack/threads/${current!.id}`, { method: 'PATCH', body: { followed: false } })
		);
		toast('Unfollowed', { body: 'You won’t be notified about new replies.' });
		await goto('?', { replace: true, refreshAll: true, reset: false });
	}

	const ago = (iso: string | null) => {
		void now;
		return iso ? formatDistanceToNowStrict(new Date(iso), { addSuffix: true }) : '';
	};
	const unreadCount = $derived(data.threads.filter((t) => t.unread).length);
</script>

<svelte:head><title>Slack · Corpus</title></svelte:head>

{#if !data.connection}
	<div class="p-4 lg:p-8">
		<div class="card">
			<EmptyState
				title="Slack isn’t connected"
				body="Connect Slack to read and reply to threads, and get notified when someone mentions you."
			>
				{#snippet icon()}<BrandIcon name="slack" class="size-5" />{/snippet}
				{#snippet action()}<a class="btn-primary h-9" href="/integrations">Go to Integrations</a
					>{/snippet}
			</EmptyState>
		</div>
	</div>
{:else}
	<div class="flex h-[calc(100dvh-72px)] flex-col gap-4 p-4 lg:p-8">
		<div class="flex flex-wrap items-center gap-3">
			<a href="/integrations" class="btn-ghost h-8 px-2 text-xs"
				><ArrowLeft class="size-3.5" /> Integrations</a
			>
			<span class="flex items-center gap-2 text-sm text-muted">
				<BrandIcon name="slack" class="size-4 text-ink" />
				{data.connection.account}
			</span>
			{#if data.connection.status === 'error'}
				<a
					class="chip bg-red-50 text-red-700"
					href="/integrations/slack/connect"
					data-sveltekit-reload>Reconnect Slack</a
				>
			{/if}
			<form class="ml-auto flex w-full gap-2 sm:w-auto" onsubmit={follow}>
				<label class="flex input h-9 flex-1 items-center gap-2 sm:w-80">
					<Link2 class="size-4 shrink-0 text-muted" />
					<input
						class="w-full min-w-0 bg-transparent text-sm outline-none"
						placeholder="Paste a Slack message link to follow"
						bind:value={link}
					/>
				</label>
				<button class="btn-outline h-9" disabled={following || !link.trim()}>
					{#if following}<LoaderCircle class="size-4 animate-spin" />{/if} Follow
				</button>
			</form>
		</div>

		<div class="grid min-h-0 flex-1 card md:grid-cols-[320px_1fr]">
			<!-- thread list -->
			<aside
				class="flex min-h-0 flex-col border-line md:border-r {current ? 'hidden md:flex' : 'flex'}"
			>
				<div class="flex gap-1 border-b border-line p-2">
					{#each [['all', 'All'], ['unread', `Unread${unreadCount ? ` · ${unreadCount}` : ''}`], ['mentions', 'Mentions']] as [v, l] (v)}
						<button
							class="rounded-md px-3 py-1 text-xs font-medium {filter === v
								? 'bg-primary-50 text-primary-600'
								: 'text-muted hover:text-ink'}"
							onclick={() => (filter = v as typeof filter)}>{l}</button
						>
					{/each}
				</div>
				<ul class="min-h-0 flex-1 scrollbar-thin divide-y divide-line overflow-y-auto">
					{#each threads as t (t.id)}
						<li>
							<button
								class="flex w-full gap-3 px-4 py-3 text-left hover:bg-canvas/60 {t.id ===
								data.selected
									? 'bg-primary-50/60'
									: ''}"
								onclick={() => open(t.id)}
							>
								<span
									class="mt-1.5 size-2 shrink-0 rounded-full {t.unread
										? 'bg-primary-500'
										: 'bg-transparent'}"
								></span>
								<span class="min-w-0 flex-1">
									<span class="flex items-center gap-1.5 text-xs text-muted">
										<span class="truncate font-medium text-ink">{t.channelName ?? 'Thread'}</span>
										{#if t.mentioned}<AtSign class="size-3 shrink-0 text-primary-500" />{/if}
										<span class="ml-auto shrink-0">{ago(t.lastActivityAt)}</span>
									</span>
									<span
										class="mt-0.5 line-clamp-2 text-[13px] {t.unread
											? 'font-medium text-ink'
											: 'text-gray-600'}"
										>{#if t.authorName}<span class="font-semibold">{t.authorName}:</span>
										{/if}{t.preview ?? 'Open to load this thread'}</span
									>
									{#if t.replyCount}<span class="mt-1 block text-[11px] text-muted"
											>{t.replyCount} {t.replyCount === 1 ? 'reply' : 'replies'}</span
										>{/if}
								</span>
							</button>
						</li>
					{:else}
						<li>
							<EmptyState
								title={filter === 'all' ? 'No threads yet' : 'Nothing here'}
								body={filter === 'all'
									? 'Threads where you’re @mentioned show up here automatically. You can also paste a message link above.'
									: 'You’re all caught up.'}
							>
								{#snippet icon()}<MessagesSquare class="size-5" />{/snippet}
							</EmptyState>
						</li>
					{/each}
				</ul>
			</aside>

			<!-- thread view -->
			<section class="flex min-h-0 flex-col {current ? 'flex' : 'hidden md:flex'}">
				{#if current}
					<header class="flex items-center gap-2 border-b border-line px-4 py-3">
						<button class="btn-icon size-8 md:hidden" aria-label="Back" onclick={() => open(null)}
							><ArrowLeft class="size-4" /></button
						>
						<div class="min-w-0 flex-1">
							<p class="truncate text-sm font-semibold">{current.channelName ?? 'Thread'}</p>
							<p class="text-xs text-muted">
								{current.replyCount}
								{current.replyCount === 1 ? 'reply' : 'replies'}
							</p>
						</div>
						{#if current.permalink}
							<a
								class="btn-ghost h-8 text-xs"
								href={current.permalink}
								target="_blank"
								rel="noreferrer"><ExternalLink class="size-3.5" /> Open in Slack</a
							>
						{/if}
						<button class="btn-ghost h-8 text-xs" onclick={unfollow}
							><BellOff class="size-3.5" /> Unfollow</button
						>
					</header>

					<div
						bind:this={scroller}
						class="min-h-0 flex-1 scrollbar-thin space-y-4 overflow-y-auto p-4"
					>
						{#if loading}
							<p class="flex items-center gap-2 text-sm text-muted">
								<LoaderCircle class="size-4 animate-spin" /> Loading thread…
							</p>
						{:else if loadError}
							<p class="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>
						{/if}
						{#each messages as m, i (m.ts)}
							<div
								class="flex gap-3 {i === 0 && messages.length > 1
									? 'border-b border-line pb-4'
									: ''}"
							>
								<Avatar name={m.author.name} image={m.author.image} size={32} />
								<div class="min-w-0 flex-1">
									<p class="flex items-baseline gap-2">
										<span class="text-sm font-semibold">{m.author.name}</span>
										<span class="text-[11px] text-muted" title={format(new Date(m.at), 'PPpp')}
											>{ago(m.at)}{m.edited ? ' · edited' : ''}</span
										>
									</p>
									<SlackText segments={m.segments} />
									{#each m.files as f (f.url)}
										<a
											href={f.url}
											target="_blank"
											rel="noreferrer"
											class="mt-1 inline-flex items-center gap-1 text-xs text-primary-600 hover:underline"
											><Paperclip class="size-3" />{f.name}</a
										>
									{/each}
								</div>
							</div>
						{/each}
					</div>

					<form
						class="border-t border-line p-3"
						onsubmit={(e) => {
							e.preventDefault();
							void send();
						}}
					>
						<div
							class="flex items-end gap-2 rounded-xl border border-line bg-surface p-2 focus-within:border-primary-500"
						>
							<textarea
								class="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent px-1 py-1.5 text-sm outline-none"
								rows="1"
								placeholder="Reply in thread…"
								bind:value={draft}
								onkeydown={(e) => {
									if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
										e.preventDefault();
										void send();
									}
								}}></textarea>
							<button
								class="btn-primary h-9 px-3"
								disabled={sending || !draft.trim()}
								aria-label="Send"
							>
								{#if sending}<LoaderCircle class="size-4 animate-spin" />{:else}<SendHorizontal
										class="size-4"
									/>{/if}
							</button>
						</div>
						<p class="mt-1.5 px-1 text-[11px] text-muted">
							Posts to Slack as you · Enter to send, Shift+Enter for a new line
						</p>
					</form>
				{:else}
					<div class="flex flex-1 items-center justify-center">
						<EmptyState
							title="Pick a thread"
							body="Read the conversation and reply without leaving Corpus."
						>
							{#snippet icon()}<MessagesSquare class="size-5" />{/snippet}
						</EmptyState>
					</div>
				{/if}
			</section>
		</div>
	</div>
{/if}
