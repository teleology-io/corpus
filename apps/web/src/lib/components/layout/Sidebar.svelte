<script lang="ts">
	import { page } from '$app/state';
	import {
		LayoutGrid,
		CalendarDays,
		NotebookText,
		Users,
		Puzzle,
		Pill,
		Settings,
		ShieldCheck,
		CircleHelp,
		Telescope,
		SquareTerminal,
		MessagesSquare,
		Workflow,
		PanelLeftClose,
		PanelLeftOpen
	} from '@lucide/svelte';
	import { Tooltip } from 'bits-ui';
	import type { Component, Snippet } from 'svelte';
	import Logo from '../ui/Logo.svelte';
	import WorkspaceCard from './WorkspaceCard.svelte';
	import { sidebar } from '#lib/stores/sidebar.svelte.js';

	// `drawer`: the mobile overlay copy, which never collapses to the icon rail.
	let { onnavigate, drawer = false }: { onnavigate?: () => void; drawer?: boolean } = $props();

	// Labels hide in the rail, so hover/focus shows them as tooltips instead.
	const tips = $derived(sidebar.compact && !drawer);

	const SLACK = '/integrations/slack';
	const main = $derived([
		{ href: '/dashboard', label: 'Dashboard', icon: LayoutGrid },
		{ href: '/calendar', label: 'My Calendar', icon: CalendarDays },
		{ href: '/cycles', label: 'Cycles', icon: Pill },
		{ href: '/notes', label: 'My Notes', icon: NotebookText },
		{ href: '/workbench', label: 'Workbench', icon: SquareTerminal },
		{ href: '/telescope', label: 'Telescope', icon: Telescope },
		{ href: '/teams', label: 'Teams', icon: Users },
		// Only once Slack is connected.
		...(page.data.slackConnected ? [{ href: SLACK, label: 'Slack', icon: MessagesSquare }] : []),
		{ href: '/integrations', label: 'Integrations', icon: Puzzle },
		...(page.data.conductor ? [{ href: '/conductor', label: 'Conductor', icon: Workflow }] : [])
	]);
	const others = [
		{ href: '/settings', label: 'Settings', icon: Settings },
		{ href: '/security', label: 'Security', icon: ShieldCheck },
		{ href: '/help', label: 'Help Me', icon: CircleHelp }
	];

	const active = (href: string) =>
		(page.url.pathname === href || page.url.pathname.startsWith(href + '/')) &&
		// The Slack entry owns its page when shown.
		!(href === '/integrations' && page.data.slackConnected && page.url.pathname.startsWith(SLACK));

	const itemClass = (on: boolean) =>
		`flex items-center gap-3 h-10 rounded-lg px-3 text-[13.5px] font-medium transition-colors compact:justify-center compact:px-0 ${
			on ? 'bg-primary-50 text-primary-600' : 'text-gray-600 hover:bg-canvas hover:text-ink'
		}`;
</script>

{#snippet tip(label: string, trigger: Snippet<[Record<string, unknown>]>)}
	<Tooltip.Root disabled={!tips}>
		<Tooltip.Trigger>
			{#snippet child({ props })}{@render trigger(props)}{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Portal>
			<Tooltip.Content
				side="right"
				sideOffset={10}
				class="z-50 rounded-md border border-line bg-surface px-2 py-1 text-xs font-medium text-ink shadow-pop"
			>
				{label}
			</Tooltip.Content>
		</Tooltip.Portal>
	</Tooltip.Root>
{/snippet}

{#snippet navItem(item: { href: string; label: string; icon: Component<{ class?: string }> })}
	{@const on = active(item.href)}
	{@const unread = item.href === SLACK && page.data.slackUnread}
	<li>
		{#snippet link(props: Record<string, unknown>)}
			<a
				{...props}
				href={item.href}
				onclick={onnavigate}
				aria-current={on ? 'page' : undefined}
				class={itemClass(on)}
			>
				<span class="relative">
					<item.icon class="size-[18px] {on ? 'text-primary-500' : 'text-gray-400'}" />
					{#if unread}
						<span
							class="absolute -top-0.5 -right-0.5 hidden size-2 rounded-full bg-primary-500 compact:block"
							aria-hidden="true"
						></span>
					{/if}
				</span>
				<span class="relative compact:sr-only">
					{item.label}
					{#if unread}
						<span
							class="absolute -top-0.5 -right-2.5 size-2 rounded-full bg-primary-500"
							role="status"
							aria-label="Unread Slack messages"
						></span>
					{/if}
				</span>
			</a>
		{/snippet}
		{@render tip(item.label, link)}
	</li>
{/snippet}

<Tooltip.Provider delayDuration={150}>
	<aside class="flex h-full w-[248px] flex-col border-r border-line bg-surface compact:w-[76px]">
		<div class="flex h-[72px] items-center px-6 compact:justify-center compact:px-0">
			<a href="/dashboard" onclick={onnavigate} aria-label="Corpus dashboard">
				<Logo wordmarkClass="compact:hidden" />
			</a>
		</div>

		<nav class="flex-1 scrollbar-thin overflow-x-hidden overflow-y-auto px-3 pt-3 pb-2">
			<ul class="space-y-0.5" aria-label="Main menu">
				{#each main as item (item.href)}{@render navItem(item)}{/each}
			</ul>

			<div class="my-5 border-t border-line"></div>

			<ul class="space-y-0.5" aria-label="Others">
				{#each others as item (item.href)}{@render navItem(item)}{/each}
				{#if !drawer}
					<li class="hidden lg:block">
						{#snippet toggle(props: Record<string, unknown>)}
							<button
								{...props}
								type="button"
								onclick={() => sidebar.toggle()}
								aria-pressed={sidebar.compact}
								aria-label={sidebar.compact ? 'Expand sidebar' : 'Collapse sidebar'}
								class="{itemClass(false)} w-full"
							>
								{#if sidebar.compact}
									<PanelLeftOpen class="size-[18px] text-gray-400" />
								{:else}
									<PanelLeftClose class="size-[18px] text-gray-400" />
								{/if}
								<span class="compact:sr-only">Collapse sidebar</span>
							</button>
						{/snippet}
						{@render tip('Expand sidebar', toggle)}
					</li>
				{/if}
			</ul>
		</nav>

		<div class="p-4 compact:flex compact:justify-center compact:px-0">
			<WorkspaceCard />
		</div>
	</aside>
</Tooltip.Provider>
