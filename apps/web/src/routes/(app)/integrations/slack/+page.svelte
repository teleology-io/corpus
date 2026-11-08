<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	import { formatDistanceToNowStrict } from 'date-fns';
	import {
		ArrowLeft,
		AtSign,
		BellOff,
		ExternalLink,
		Hash,
		Link2,
		LoaderCircle,
		Lock,
		MessagesSquare,
		Plus,
		RefreshCw,
		Search,
		Users
	} from '@lucide/svelte';
	import BrandIcon from '#lib/components/ui/BrandIcon.svelte';
	import Avatar from '#lib/components/ui/Avatar.svelte';
	import EmptyState from '#lib/components/ui/EmptyState.svelte';
	import SlackComposer from '#lib/components/slack/SlackComposer.svelte';
	import SlackMessageItem from '#lib/components/slack/SlackMessageItem.svelte';
	import SlackConversation from '#lib/components/slack/SlackConversation.svelte';
	import SlackThreadPanel from '#lib/components/slack/SlackThreadPanel.svelte';
	import SlackSearch from '#lib/components/slack/SlackSearch.svelte';
	import SlackBrowseModal from '#lib/components/slack/SlackBrowseModal.svelte';
	import { startPoller } from '#lib/components/slack/poller.js';
	import { api } from '#lib/api.js';
	import { attempt, toast } from '#lib/stores/toast.svelte.js';
	import type {
		SlackConversationDTO,
		SlackMessageDTO,
		SlackSearchResultDTO,
		SlackThreadDTO
	} from '#lib/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// ----- URL state: ?thread=<followed id> | ?c=<channel>[&t=<thread ts>][&ts=<focus>] | ?q= -----
	const params = $derived(page.url.searchParams);
	const channelId = $derived(params.get('c'));
	const threadTs = $derived(params.get('t'));
	const focusTs = $derived(params.get('ts'));
	const query = $derived(params.get('q'));

	function nav(next: Record<string, string | null>, keep = false) {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- builds a URL for goto only
		const q = new URLSearchParams(keep ? page.url.search : undefined);
		for (const [k, v] of Object.entries(next)) {
			if (v) q.set(k, v);
			else q.delete(k);
		}
		const s = q.toString();
		return goto(s ? `?${s}` : '?', { replace: true, reset: false });
	}

	// ----- sidebar -----
	let tab = $state<'chats' | 'threads'>(untrack(() => (data.selected ? 'threads' : 'chats')));
	let filter = $state<'all' | 'unread' | 'mentions'>('all');
	let convFilter = $state('');
	let searchText = $state(untrack(() => page.url.searchParams.get('q') ?? ''));
	let browseOpen = $state(false);
	let refreshing = $state(false);
	let now = $state(new Date());
	/** Conversations opened from browse/search that aren't in the member list */
	let picked = $state<Record<string, SlackConversationDTO>>({});

	onMount(() => {
		const t = setInterval(() => (now = new Date()), 30_000);
		return () => clearInterval(t);
	});

	const known = $derived.by(() => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- rebuilt by $derived, never mutated after
		const map = new Map<string, SlackConversationDTO>();
		for (const c of Object.values(picked)) map.set(c.id, c);
		if (data.extra) map.set(data.extra.id, data.extra);
		for (const c of data.conversations) map.set(c.id, c);
		return map;
	});
	const currentConv = $derived(
		channelId
			? (known.get(channelId) ?? {
					id: channelId,
					kind: channelId.startsWith('D') ? ('im' as const) : ('public' as const),
					name: channelId,
					topic: null,
					image: null,
					unread: false,
					latestAt: null,
					inaccessible: null
				})
			: null
	);
	const matches = (c: SlackConversationDTO) =>
		!convFilter.trim() || c.name.toLowerCase().includes(convFilter.trim().toLowerCase());
	const channels = $derived(
		data.conversations.filter((c) => (c.kind === 'public' || c.kind === 'private') && matches(c))
	);
	const dms = $derived(
		data.conversations.filter((c) => (c.kind === 'im' || c.kind === 'mpim') && matches(c))
	);

	const threads = $derived(
		data.threads.filter((t) =>
			filter === 'unread' ? t.unread : filter === 'mentions' ? t.mentioned : true
		)
	);
	const unreadCount = $derived(data.threads.filter((t) => t.unread).length);
	const current = $derived(data.threads.find((t) => t.id === data.selected) ?? null);
	const mode = $derived(
		query ? 'search' : current ? 'followed' : currentConv ? 'conversation' : 'none'
	);

	const ago = (iso: string | null) => {
		void now;
		return iso ? formatDistanceToNowStrict(new Date(iso), { addSuffix: true }) : 'never';
	};

	function openConversation(
		c: SlackConversationDTO | null,
		extra: Record<string, string | null> = {}
	) {
		if (c && !data.conversations.some((x) => x.id === c.id)) picked = { ...picked, [c.id]: c };
		return nav({ c: c?.id ?? null, t: null, ts: null, thread: null, q: null, ...extra });
	}

	function openResult(r: SlackSearchResultDTO) {
		if (!r.channelId) {
			if (r.permalink) window.open(r.permalink, '_blank', 'noreferrer');
			return;
		}
		const conv = known.get(r.channelId) ?? {
			id: r.channelId,
			kind: r.channelId.startsWith('D') ? ('im' as const) : ('public' as const),
			name: r.channelName.replace(/^#/, ''),
			topic: null,
			image: null,
			unread: false,
			latestAt: null,
			inaccessible: null
		};
		if (r.kind === 'file') return openConversation(conv);
		return openConversation(conv, r.threadTs ? { t: r.threadTs, ts: r.ts } : { ts: r.ts });
	}

	function search(e: SubmitEvent) {
		e.preventDefault();
		const q = searchText.trim();
		if (q) void nav({ q, thread: null }, true);
	}

	async function refreshAll() {
		refreshing = true;
		await attempt(() => api('/api/slack/refresh', { method: 'POST' }));
		await invalidate('app:slack');
		refreshing = false;
	}

	// ----- followed thread (existing inbox) -----
	let link = $state('');
	let following = $state(false);
	let messages = $state<SlackMessageDTO[]>([]);
	let loading = $state(false);
	let loadError = $state<string | null>(null);
	let scroller = $state<HTMLDivElement>();

	// Reload when switching threads or when live polling sees new activity; poll every 10 s while open.
	let loadedKey = '';
	$effect(() => {
		const key = current ? `${current.id}:${current.lastActivityAt}` : '';
		if (!current || key === loadedKey) return;
		const switching = !loadedKey.startsWith(current.id);
		loadedKey = key;
		void load(current.id, switching);
	});
	$effect(() => {
		const id = current?.id;
		if (!id) return;
		const p = startPoller(() => load(id, false).then(() => null), 10_000);
		return () => p.stop();
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
			const stick =
				!scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
			const grew = res.messages.length !== messages.length;
			messages = res.messages;
			// Opening marked it read; let the list (and its unread dot) catch up.
			if (current?.unread)
				void Promise.all([invalidate('app:integrations'), invalidate('app:slack-unread')]);
			await tick();
			if (switching || (grew && stick)) scroller?.scrollTo({ top: scroller.scrollHeight });
		} catch (e) {
			if (switching) loadError = (e as Error).message;
			else throw e;
		} finally {
			loading = false;
		}
	}

	function openThread(id: string | null) {
		return nav({ thread: id, c: null, t: null, ts: null, q: null });
	}

	async function follow(e: SubmitEvent) {
		e.preventDefault();
		if (!link.trim()) return;
		following = true;
		const res = await attempt(() => api<{ id: string }>('/api/slack/threads', { body: { link } }));
		following = false;
		if (!res) return;
		link = '';
		tab = 'threads';
		await goto(`?thread=${res.id}`, { replace: true, refreshAll: true, reset: false });
	}

	async function reply(text: string) {
		if (!current) return false;
		const id = current.id;
		const ok = await attempt(
			() => api(`/api/slack/threads/${id}/reply`, { body: { text } }).then(() => true),
			'Could not send reply'
		);
		if (!ok) return false;
		await load(id, false);
		await invalidate('app:integrations');
		return true;
	}

	async function unfollow() {
		if (!current) return;
		await attempt(() =>
			api(`/api/slack/threads/${current!.id}`, { method: 'PATCH', body: { followed: false } })
		);
		toast('Unfollowed', { body: 'You won’t be notified about new replies.' });
		await goto('?', { replace: true, refreshAll: true, reset: false });
	}

	const showMain = $derived(mode !== 'none');
	const threadTitle = $derived(
		currentConv
			? currentConv.kind === 'public' || currentConv.kind === 'private'
				? `#${currentConv.name}`
				: currentConv.name
			: ''
	);
</script>

<svelte:head><title>Slack · Corpus</title></svelte:head>

{#snippet convRow(c: SlackConversationDTO)}
	<li>
		<button
			class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-canvas/60 {c.id ===
				channelId && mode === 'conversation'
				? 'bg-primary-50/70 text-primary-700'
				: c.unread
					? 'font-semibold text-ink'
					: 'text-gray-600'}"
			onclick={() => openConversation(c)}
			title={c.inaccessible ? 'Corpus can’t read this conversation' : undefined}
		>
			{#if c.kind === 'im'}
				<Avatar name={c.name} image={c.image} size={18} />
			{:else if c.kind === 'mpim'}
				<Users class="size-3.5 shrink-0 text-muted" />
			{:else if c.kind === 'private'}
				<Lock class="size-3.5 shrink-0 text-muted" />
			{:else}
				<Hash class="size-3.5 shrink-0 text-muted" />
			{/if}
			<span class="min-w-0 flex-1 truncate {c.inaccessible ? 'opacity-50' : ''}">{c.name}</span>
			{#if c.unread}<span class="size-2 shrink-0 rounded-full bg-primary-500"></span>{/if}
		</button>
	</li>
{/snippet}

{#if !data.connection}
	<div class="p-4 lg:p-8">
		<div class="card">
			<EmptyState
				title="Slack isn’t connected"
				body="Connect Slack to read channels and DMs, search, and reply — and get notified when someone mentions you."
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
			<span class="flex min-w-0 items-center gap-2 text-sm text-muted">
				<BrandIcon name="slack" class="size-4 shrink-0 text-ink" />
				<span class="truncate">{data.connection.account}</span>
				{#if data.identity?.userId}<span
						class="hidden font-mono text-[11px] text-muted lg:inline"
						title="Slack user ID">{data.identity.userId}</span
					>{/if}
				<span class="hidden text-xs sm:inline"
					>· synced {ago(data.identity?.lastSyncedAt ?? null)}</span
				>
			</span>
			{#if data.connection.status === 'error'}
				<a class="chip bg-red-50 text-red-700" href="/integrations">Reconnect Slack</a>
			{:else if data.connection.status === 'paused'}
				<a class="chip bg-canvas text-muted" href="/integrations">Background sync paused</a>
			{/if}
			<form class="ml-auto flex w-full gap-2 sm:w-auto" onsubmit={search}>
				<label class="flex input h-9 flex-1 items-center gap-2 sm:w-72">
					<Search class="size-4 shrink-0 text-muted" />
					<input
						class="w-full min-w-0 bg-transparent text-sm outline-none"
						placeholder="Search Slack"
						bind:value={searchText}
					/>
				</label>
				<button
					type="button"
					class="btn-icon size-9"
					aria-label="Refresh"
					title="Refresh"
					disabled={refreshing || data.connection.status === 'error'}
					onclick={refreshAll}
					><RefreshCw class="size-4 {refreshing ? 'animate-spin' : ''}" /></button
				>
			</form>
		</div>

		{#if data.warning}
			<p class="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{data.warning}</p>
		{/if}
		{#if data.identity?.missingScopes.length}
			<p class="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
				Slack reports this token is missing {data.identity.missingScopes.join(', ')} — some features won’t
				work. Add them under <strong>User Token Scopes</strong> (not Bot Token Scopes) in your Slack app,
				reinstall it, and update the token if Slack issued a new one.
			</p>
		{/if}

		<div
			class="grid min-h-0 flex-1 card md:grid-cols-[280px_1fr] {mode === 'conversation' && threadTs
				? 'lg:grid-cols-[280px_1fr_360px]'
				: ''}"
		>
			<!-- sidebar -->
			<aside
				class="flex min-h-0 flex-col border-line md:border-r {showMain ? 'hidden md:flex' : 'flex'}"
			>
				<div class="flex gap-1 border-b border-line p-2">
					<button
						class="rounded-md px-3 py-1 text-xs font-medium {tab === 'chats'
							? 'bg-primary-50 text-primary-600'
							: 'text-muted hover:text-ink'}"
						onclick={() => (tab = 'chats')}>Channels & DMs</button
					>
					<button
						class="rounded-md px-3 py-1 text-xs font-medium {tab === 'threads'
							? 'bg-primary-50 text-primary-600'
							: 'text-muted hover:text-ink'}"
						onclick={() => (tab = 'threads')}
						>Threads{unreadCount ? ` · ${unreadCount}` : ''}</button
					>
				</div>

				{#if tab === 'chats'}
					<div class="flex gap-2 border-b border-line p-2">
						<input
							class="input h-8 min-w-0 flex-1 text-xs"
							placeholder="Jump to…"
							bind:value={convFilter}
						/>
						<button
							class="btn-icon size-8"
							aria-label="Browse channels"
							title="Browse channels"
							disabled={data.connection.status === 'error'}
							onclick={() => (browseOpen = true)}><Plus class="size-4" /></button
						>
					</div>
					<div class="min-h-0 flex-1 scrollbar-thin space-y-4 overflow-y-auto p-2">
						{#if data.connection.status === 'error'}
							<p class="p-2 text-xs text-muted">Reconnect Slack to load your conversations.</p>
						{:else}
							<section>
								<p class="mb-1 section-label px-2">Channels</p>
								<ul>
									{#each channels as c (c.id)}{@render convRow(c)}{:else}
										<li class="px-2 text-xs text-muted">No channels</li>
									{/each}
								</ul>
							</section>
							<section>
								<p class="mb-1 section-label px-2">Direct messages</p>
								<ul>
									{#each dms as c (c.id)}{@render convRow(c)}{:else}
										<li class="px-2 text-xs text-muted">No direct messages</li>
									{/each}
								</ul>
							</section>
						{/if}
					</div>
				{:else}
					<div class="flex gap-1 border-b border-line p-2">
						{#each [['all', 'All'], ['unread', 'Unread'], ['mentions', 'Mentions']] as [v, l] (v)}
							<button
								class="rounded-md px-2.5 py-0.5 text-[11px] font-medium {filter === v
									? 'bg-canvas text-ink'
									: 'text-muted hover:text-ink'}"
								onclick={() => (filter = v as typeof filter)}>{l}</button
							>
						{/each}
					</div>
					<form class="flex gap-2 border-b border-line p-2" onsubmit={follow}>
						<label class="flex input h-8 min-w-0 flex-1 items-center gap-2">
							<Link2 class="size-3.5 shrink-0 text-muted" />
							<input
								class="w-full min-w-0 bg-transparent text-xs outline-none"
								placeholder="Paste a message link to follow"
								bind:value={link}
							/>
						</label>
						<button class="btn-outline h-8 text-xs" disabled={following || !link.trim()}>
							{#if following}<LoaderCircle class="size-3.5 animate-spin" />{/if} Follow
						</button>
					</form>
					<ul class="min-h-0 flex-1 scrollbar-thin divide-y divide-line overflow-y-auto">
						{#each threads as t (t.id)}
							<li>
								<button
									class="flex w-full gap-3 px-4 py-3 text-left hover:bg-canvas/60 {t.id ===
									data.selected
										? 'bg-primary-50/60'
										: ''}"
									onclick={() => openThread(t.id)}
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
										? 'Threads where you’re @mentioned or that you reply to show up here.'
										: 'You’re all caught up.'}
								>
									{#snippet icon()}<MessagesSquare class="size-5" />{/snippet}
								</EmptyState>
							</li>
						{/each}
					</ul>
				{/if}
			</aside>

			<!-- main pane -->
			<section
				class="min-h-0 flex-col {mode === 'conversation' && threadTs
					? 'hidden lg:flex'
					: showMain
						? 'flex'
						: 'hidden md:flex'}"
			>
				{#if mode === 'search' && query}
					<SlackSearch
						{query}
						onquery={(q) => {
							searchText = q;
							void nav({ q }, true);
						}}
						onopen={openResult}
						onclose={() => {
							searchText = '';
							void nav({ q: null }, true);
						}}
					/>
				{:else if mode === 'followed' && current}
					<header class="flex items-center gap-2 border-b border-line px-4 py-3">
						<button
							class="btn-icon size-8 md:hidden"
							aria-label="Back"
							onclick={() => openThread(null)}><ArrowLeft class="size-4" /></button
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
							<div class={i === 0 && messages.length > 1 ? 'border-b border-line pb-4' : ''}>
								<SlackMessageItem {m} {now} />
							</div>
						{/each}
					</div>
					<SlackComposer placeholder="Reply in thread…" onsend={reply} />
				{:else if mode === 'conversation' && currentConv}
					<SlackConversation
						conversation={currentConv}
						{focusTs}
						onthread={(ts) => nav({ t: ts, ts: null }, true)}
						onback={() => openConversation(null)}
					/>
				{:else}
					<div class="flex flex-1 items-center justify-center">
						<EmptyState
							title="Pick a conversation"
							body="Read channels, DMs and threads, search, and reply without leaving Corpus."
						>
							{#snippet icon()}<MessagesSquare class="size-5" />{/snippet}
						</EmptyState>
					</div>
				{/if}
			</section>

			<!-- thread panel (channel threads) -->
			{#if mode === 'conversation' && currentConv && threadTs}
				<section class="flex min-h-0 flex-col border-line lg:border-l">
					<SlackThreadPanel
						channelId={currentConv.id}
						{threadTs}
						title={threadTitle}
						focusTs={focusTs && focusTs !== threadTs ? focusTs : null}
						onclose={() => nav({ t: null }, true)}
					/>
				</section>
			{/if}
		</div>
	</div>

	<SlackBrowseModal
		bind:open={browseOpen}
		onpick={(c) =>
			openConversation({
				id: c.id,
				kind: c.kind,
				name: c.name,
				topic: c.topic,
				image: null,
				unread: false,
				latestAt: null,
				inaccessible: null
			})}
	/>
{/if}
