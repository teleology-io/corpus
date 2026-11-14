<script lang="ts">
	import './layout.css';
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { navigating, page } from '$app/state';
	import {
		ExternalLink,
		LayoutGrid,
		Plug,
		RefreshCw,
		ScrollText,
		Timer,
		Users
	} from '@lucide/svelte';
	import Time from '#lib/components/Time.svelte';
	import Toaster from '#lib/components/Toaster.svelte';
	import { toast } from '#lib/toast.svelte.js';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	const nav = [
		{
			href: '/',
			label: 'Overview',
			icon: LayoutGrid,
			blurb: 'Health, activity, and the jobs that need your attention.'
		},
		{
			href: '/jobs',
			label: 'Jobs',
			icon: Timer,
			blurb: 'Inspect scheduled work and recover failed runs.'
		},
		{
			href: '/integrations',
			label: 'Integrations',
			icon: Plug,
			blurb: 'Connection health across every workspace.'
		},
		{
			href: '/users',
			label: 'Users & workspaces',
			icon: Users,
			blurb: 'Inspect accounts, workspace membership, and access.'
		},
		{
			href: '/audit',
			label: 'Audit log',
			icon: ScrollText,
			blurb: 'A record of every change made from this panel.'
		}
	];
	const active = $derived(
		nav.find((n) =>
			n.href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(n.href)
		)
	);
	const initials = $derived(
		data.admin.name
			.split(/\s+/)
			.map((p) => p[0])
			.join('')
			.slice(0, 2)
			.toUpperCase()
	);

	let refreshing = $state(false);
	async function refresh(manual: boolean) {
		if (refreshing) return;
		refreshing = true;
		try {
			await invalidateAll();
			if (page.error) toast('Refresh failed. Showing the last data that loaded.', 'error');
			else if (manual) toast('Data refreshed');
		} catch {
			toast('Refresh failed. Check that the admin server is reachable.', 'error');
		} finally {
			refreshing = false;
		}
	}

	// Keep numbers fresh, but never while a drawer or confirm dialog is open.
	onMount(() => {
		const t = setInterval(() => {
			if (document.visibilityState === 'visible' && !document.querySelector('dialog[open]'))
				void refresh(false);
		}, 30_000);
		return () => clearInterval(t);
	});
</script>

<svelte:head>
	<title>{active ? `${active.label} · ` : ''}Corpus Admin</title>
</svelte:head>

{#snippet logo()}
	<a href="/" class="flex items-center gap-2.5">
		<span
			class="grid size-8 place-items-center rounded-lg bg-primary-500 text-lg font-bold text-white"
			>C</span
		>
		<span class="text-xl font-bold tracking-tight">Corpus</span>
		<span
			class="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-violet-700"
			>ADMIN</span
		>
	</a>
{/snippet}

{#snippet links(compact: boolean)}
	{#each nav as item (item.href)}
		{@const Icon = item.icon}
		<a
			href={item.href}
			aria-current={active === item ? 'page' : undefined}
			class="flex shrink-0 items-center gap-3 rounded-lg px-3 text-sm font-medium whitespace-nowrap text-gray-600 hover:bg-canvas aria-[current=page]:bg-primary-50 aria-[current=page]:text-primary-600 {compact
				? 'py-2'
				: 'py-2.5'}"
		>
			<Icon size={18} />
			{item.label}
		</a>
	{/each}
{/snippet}

<div class="lg:grid lg:min-h-dvh lg:grid-cols-[240px_1fr]">
	<!-- Desktop sidebar -->
	<aside
		class="sticky top-0 hidden h-dvh flex-col border-r border-line bg-surface px-4 py-6 lg:flex"
	>
		<div class="mb-9 px-2">{@render logo()}</div>
		<p class="eyebrow mb-2 px-3">Platform</p>
		<nav class="flex flex-col gap-0.5" aria-label="Admin sections">{@render links(false)}</nav>
		<div class="mt-auto border-t border-line px-3 pt-4 text-xs text-muted">
			<a
				href={data.appUrl}
				class="flex items-center gap-1.5 font-medium text-primary-600 hover:underline"
			>
				Open Corpus <ExternalLink size={13} />
			</a>
			<p class="mt-1.5">Infrastructure administration</p>
		</div>
	</aside>

	<div class="min-w-0">
		<header class="sticky top-0 z-10 border-b border-line bg-surface/95 backdrop-blur">
			<div class="flex h-16 items-center justify-between gap-4 px-4 sm:px-8">
				<span class="lg:hidden">{@render logo()}</span>
				<strong class="hidden text-lg lg:block">Admin panel</strong>
				<div class="flex items-center gap-4 text-sm">
					<span
						class="flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium {data.environment ===
						'Production'
							? 'border-amber-200 bg-amber-50 text-amber-800'
							: 'border-emerald-200 bg-emerald-50 text-emerald-800'}"
					>
						<span class="size-1.5 rounded-full bg-current"></span>
						{data.environment}
					</span>
					<span class="flex items-center gap-2.5" title={data.admin.email}>
						<span
							class="grid size-9 place-items-center rounded-full bg-violet-600 text-xs font-semibold text-white"
							>{initials}</span
						>
						<span class="hidden leading-tight sm:block">
							<span class="block font-medium">{data.admin.name}</span>
							<span class="block text-xs text-muted">{data.admin.email}</span>
						</span>
					</span>
				</div>
			</div>
			<!-- Narrow screens: sections as a scrollable row -->
			<nav
				class="flex gap-1 overflow-x-auto border-t border-line px-3 py-2 lg:hidden"
				aria-label="Admin sections"
			>
				{@render links(true)}
			</nav>
		</header>

		<main class="px-4 py-6 sm:px-9 sm:py-8">
			<div class="mb-7 flex flex-wrap items-end justify-between gap-4">
				<div>
					<p class="eyebrow">Corpus infrastructure</p>
					<h1 class="mt-2 text-3xl font-bold tracking-tight">{active?.label ?? 'Admin'}</h1>
					{#if active}<p class="mt-1.5 text-sm text-muted">{active.blurb}</p>{/if}
				</div>
				<div class="flex items-center gap-3">
					<span class="text-xs text-muted" aria-live="polite"
						>Updated <Time at={data.loadedAt} /></span
					>
					<button type="button" class="btn" onclick={() => refresh(true)} disabled={refreshing}>
						<RefreshCw size={15} class={refreshing || navigating.to ? 'animate-spin' : ''} />
						{refreshing ? 'Refreshing…' : 'Refresh'}
					</button>
				</div>
			</div>
			{@render children()}
		</main>
	</div>
</div>

<Toaster />
