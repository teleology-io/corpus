<script lang="ts">
	import { onMount } from 'svelte';
	import { refreshAll } from '$app/navigation';
	import { formatDistanceToNowStrict } from 'date-fns';
	import {
		RefreshCw,
		Unplug,
		ExternalLink,
		CircleAlert,
		Eye,
		GitPullRequest,
		CircleDot,
		MessagesSquare,
		CalendarDays,
		Settings2
	} from '@lucide/svelte';
	import BrandIcon from '#lib/components/ui/BrandIcon.svelte';
	import Switch from '#lib/components/ui/Switch.svelte';
	import EmptyState from '#lib/components/ui/EmptyState.svelte';
	import GoogleCalendars from '#lib/components/integrations/GoogleCalendars.svelte';
	import AppSetupModal, { type AppTarget } from '#lib/components/integrations/AppSetupModal.svelte';
	import TokenConnectModal, {
		type TokenTarget
	} from '#lib/components/integrations/TokenConnectModal.svelte';
	import { api } from '#lib/api.js';
	import { attempt, toast } from '#lib/stores/toast.svelte.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let filter = $state<string>('all');
	let now = $state(new Date());
	let appOpen = $state(false);
	let appTarget = $state<AppTarget | null>(null);
	let tokenOpen = $state(false);
	let tokenTarget = $state<TokenTarget | null>(null);

	const setupApp = (p: AppTarget) => ((appTarget = p), (appOpen = true));
	function connectToken(p: (typeof data.catalog)[number]) {
		if (!p.personalToken) return;
		tokenTarget = { id: p.id, name: p.name, personalToken: p.personalToken };
		tokenOpen = true;
	}

	onMount(() => {
		if (data.connected) {
			const name = data.catalog.find((p) => p.id === data.connected)?.name ?? 'Integration';
			const body: Record<string, string> = {
				'google-calendar': 'Syncing your primary calendar — pick more below.',
				slack: 'Watching for mentions. Open Slack threads to read and reply.'
			};
			toast(`${name} connected`, {
				tone: 'success',
				body: body[data.connected] ?? 'Importing your items now…'
			});
		}
		if (data.error) toast('Connection cancelled', { tone: 'error', body: data.error });
		const t = setInterval(() => (now = new Date()), 15_000);
		return () => clearInterval(t);
	});

	const NOTIFY_LABEL: Record<string, string> = {
		'google-calendar': 'Notify me about invites & changes',
		slack: 'Notify me about mentions & replies'
	};
	const connectionFor = (id: string) => data.connections.find((c) => c.provider === id);
	const items = $derived(
		filter === 'all' ? data.items : data.items.filter((i) => i.provider === filter)
	);
	const KIND = {
		review_request: { label: 'Review', icon: Eye },
		pull_request: { label: 'PR', icon: GitPullRequest },
		issue: { label: 'Issue', icon: CircleDot }
	} as const;

	async function refresh(id: string) {
		await attempt(() => api(`/api/integrations/${id}/poll`, { method: 'POST' }));
		toast('Refreshing…', { body: 'New items appear automatically.' });
	}

	async function disconnect(id: string, name: string) {
		const what: Record<string, string> = {
			'Google Calendar':
				'Synced calendars and their events are removed from Corpus (nothing is deleted in Google).',
			Slack: 'Followed threads are removed from Corpus.'
		};
		if (!confirm(`Disconnect ${name}? ${what[name] ?? 'Imported tasks stay; items are removed.'}`))
			return;
		await attempt(() => api(`/api/integrations/${id}`, { method: 'DELETE' }));
		await refreshAll();
	}

	async function setting(id: string, key: 'syncTasks' | 'notify', value: boolean) {
		await attempt(() =>
			api(`/api/integrations/${id}`, { method: 'PATCH', body: { [key]: value } })
		);
	}

	// Reads `now` so relative times re-render on the interval tick.
	const ago = (iso: string | null) => {
		void now;
		return iso ? formatDistanceToNowStrict(new Date(iso), { addSuffix: true }) : 'never';
	};
</script>

<svelte:head><title>Integrations · Corpus</title></svelte:head>

<div class="space-y-8 p-4 lg:p-8">
	<section>
		<h2 class="text-lg font-semibold">Your integrations</h2>
		<p class="mb-4 text-sm text-muted">
			Connections are personal to your account. Items are checked about every minute and show up
			live on your dashboard.
		</p>
		<div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
			{#each data.catalog as p (p.id)}
				{@const c = connectionFor(p.id)}
				<div class="flex flex-col card p-5">
					<div class="flex items-start gap-3">
						<span
							class="flex size-11 items-center justify-center rounded-xl border border-line bg-canvas text-ink"
							><BrandIcon name={p.id} class="size-6" /></span
						>
						<div class="min-w-0 flex-1">
							<p class="flex items-center gap-2 font-semibold">
								{p.name}
								{#if c?.status === 'active'}<span class="chip bg-emerald-50 text-emerald-700"
										><span class="size-1.5 rounded-full bg-emerald-500"></span>Live</span
									>
								{:else if c?.status === 'error'}<span class="chip bg-red-50 text-red-700"
										><CircleAlert class="size-3" />Needs attention</span
									>
								{:else if !p.available}<span class="chip bg-canvas text-muted">Coming soon</span
									>{/if}
							</p>
							<p class="mt-0.5 text-xs text-muted">{p.description}</p>
						</div>
					</div>

					{#if c}
						<div class="mt-4 space-y-2.5 rounded-lg bg-canvas p-3 text-xs">
							<div class="flex items-center gap-2">
								{#if c.accountAvatar}<img
										src={c.accountAvatar}
										alt=""
										class="size-5 rounded-full"
									/>{/if}
								<span class="font-medium">{c.accountLogin}</span>
								<span class="ml-auto text-muted">synced {ago(c.lastPolledAt)}</span>
							</div>
							{#if c.lastError}<p class="text-red-600">{c.lastError}</p>{/if}
							{#if p.id === 'github' || p.id === 'linear'}
								<label class="flex items-center justify-between"
									>Add review requests & issues as tasks <Switch
										checked={c.settings.syncTasks !== false}
										onchange={(v) => setting(c.id, 'syncTasks', v)}
									/></label
								>
							{/if}
							{#if p.id === 'google-calendar' && c.status === 'active'}
								<GoogleCalendars connectionId={c.id} />
							{/if}
							<label class="flex items-center justify-between"
								>{NOTIFY_LABEL[p.id] ?? 'Notify me about new items'}
								<Switch
									checked={c.settings.notify !== false}
									onchange={(v) => setting(c.id, 'notify', v)}
								/></label
							>
						</div>
						{#if p.id === 'slack' && c.status === 'active'}
							<a class="mt-3 btn-primary h-8 w-full text-xs" href="/integrations/slack"
								><MessagesSquare class="size-3.5" /> Open threads{data.slackUnread
									? ` · ${data.slackUnread} unread`
									: ''}</a
							>
						{:else if p.id === 'google-calendar' && c.status === 'active'}
							<a class="mt-3 btn-outline h-8 w-full text-xs" href="/calendar"
								><CalendarDays class="size-3.5" /> Open My Calendar</a
							>
						{/if}
						<div class="mt-2 flex gap-2">
							{#if c.status === 'error' && c.authType === 'token'}
								<button class="btn-primary h-8 flex-1 text-xs" onclick={() => connectToken(p)}
									>Update token</button
								>
							{:else if c.status === 'error'}
								<a
									class="btn-primary h-8 flex-1 text-xs"
									href="/integrations/{p.id}/connect"
									data-sveltekit-reload>Reconnect</a
								>
							{:else}
								<button class="btn-outline h-8 flex-1 text-xs" onclick={() => refresh(c.id)}
									><RefreshCw class="size-3.5" /> Refresh now</button
								>
							{/if}
							<button
								class="btn-ghost h-8 text-xs hover:text-red-600"
								onclick={() => disconnect(c.id, p.name)}
								><Unplug class="size-3.5" /> Disconnect</button
							>
						</div>
					{:else if p.available}
						<div class="mt-auto space-y-2 pt-5">
							{#if p.configured}
								<a
									class="btn-primary h-9 w-full"
									href="/integrations/{p.id}/connect"
									data-sveltekit-reload>Connect {p.name}</a
								>
								{#if p.personalToken}
									<button class="btn-ghost h-8 w-full text-xs" onclick={() => connectToken(p)}
										>Use a {p.personalToken.label.toLowerCase()} instead</button
									>
								{/if}
							{:else}
								{#if p.personalToken}
									<button class="btn-primary h-9 w-full" onclick={() => connectToken(p)}
										>Connect with {p.personalToken.label.toLowerCase()}</button
									>
								{/if}
								{#if data.isAdmin}
									<button
										class="h-9 w-full {p.personalToken ? 'btn-ghost text-xs' : 'btn-outline'}"
										onclick={() => setupApp(p)}
										><Settings2 class="size-3.5" /> Set up OAuth app</button
									>
								{:else if !p.personalToken}
									<p class="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
										An admin needs to set up {p.name} before you can connect it.
									</p>
								{/if}
							{/if}
						</div>
					{/if}
					{#if data.isAdmin && p.available && p.configured}
						<button
							class="mt-3 flex items-center gap-1.5 self-start text-[11px] text-muted hover:text-ink"
							onclick={() => setupApp(p)}
							><Settings2 class="size-3" />
							OAuth app{p.app.source === 'env' ? ' · from .env' : ''}</button
						>
					{/if}
				</div>
			{/each}
		</div>
	</section>

	<section>
		<div class="mb-3 flex flex-wrap items-center gap-3">
			<h2 class="text-lg font-semibold">Open items</h2>
			<div class="ml-auto flex gap-1 rounded-lg border border-line bg-surface p-0.5">
				{#each ['all', ...data.connections
						.map((c) => c.provider)
						.filter((p) => p === 'github' || p === 'linear')] as f (f)}
					<button
						class="rounded-md px-3 py-1 text-xs font-medium capitalize {filter === f
							? 'bg-primary-50 text-primary-600'
							: 'text-muted hover:text-ink'}"
						onclick={() => (filter = f)}>{f}</button
					>
				{/each}
			</div>
		</div>
		<div class="card">
			{#if items.length}
				<ul class="divide-y divide-line">
					{#each items as i (i.id)}
						{@const k = KIND[i.kind as keyof typeof KIND]}
						<li>
							<a
								href={i.url}
								target="_blank"
								rel="noreferrer"
								class="flex items-center gap-3 px-4 py-3 hover:bg-canvas/60"
							>
								<BrandIcon name={i.provider} class="size-4 shrink-0" />
								{#if k}<span class="chip shrink-0 bg-canvas text-muted"
										><k.icon class="size-3" />{k.label}</span
									>{/if}
								<span class="min-w-0 flex-1">
									<span class="block truncate text-sm font-medium">{i.title}</span>
									<span class="block truncate text-xs text-muted"
										>{i.subtitle}{i.state ? ` · ${i.state}` : ''}</span
									>
								</span>
								<span class="hidden shrink-0 text-xs text-muted sm:block">{ago(i.updatedAt)}</span>
								<ExternalLink class="size-3.5 shrink-0 text-muted" />
							</a>
						</li>
					{/each}
				</ul>
			{:else}
				<EmptyState
					title="Nothing open"
					body={data.connections.length
						? 'You’re clear — no reviews, PRs or issues waiting.'
						: 'Connect GitHub or Linear above to see your work here.'}
				>
					{#snippet icon()}<GitPullRequest class="size-5" />{/snippet}
				</EmptyState>
			{/if}
		</div>
	</section>
</div>

<AppSetupModal bind:open={appOpen} target={appTarget} />
<TokenConnectModal bind:open={tokenOpen} target={tokenTarget} />
