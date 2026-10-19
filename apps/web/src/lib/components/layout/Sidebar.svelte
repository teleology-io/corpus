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
		CircleHelp
	} from '@lucide/svelte';
	import Logo from '../ui/Logo.svelte';
	import WorkspaceCard from './WorkspaceCard.svelte';

	let { onnavigate }: { onnavigate?: () => void } = $props();

	const main = [
		{ href: '/dashboard', label: 'Dashboard', icon: LayoutGrid },
		{ href: '/calendar', label: 'My Calendar', icon: CalendarDays },
		{ href: '/cycles', label: 'Cycles', icon: Pill },
		{ href: '/notes', label: 'My Notes', icon: NotebookText },
		{ href: '/teams', label: 'Teams', icon: Users },
		{ href: '/integrations', label: 'Integrations', icon: Puzzle }
	];
	const others = [
		{ href: '/settings', label: 'Settings', icon: Settings },
		{ href: '/security', label: 'Security', icon: ShieldCheck },
		{ href: '/help', label: 'Help Me', icon: CircleHelp }
	];

	const active = (href: string) =>
		page.url.pathname === href || page.url.pathname.startsWith(href + '/');
</script>

<aside class="flex h-full w-[248px] flex-col border-r border-line bg-surface">
	<div class="flex h-[72px] items-center px-6">
		<a href="/dashboard" onclick={onnavigate}><Logo /></a>
	</div>

	<nav class="flex-1 scrollbar-thin overflow-y-auto px-3 pt-3">
		<p class="mb-2 section-label">Main Menu</p>
		<ul class="space-y-0.5">
			{#each main as item (item.href)}
				{@const on = active(item.href)}
				<li>
					<a
						href={item.href}
						onclick={onnavigate}
						aria-current={on ? 'page' : undefined}
						class="flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13.5px] font-medium transition-colors {on
							? 'bg-primary-50 text-primary-600'
							: 'text-gray-600 hover:bg-canvas hover:text-ink'}"
					>
						<item.icon class="size-[18px] {on ? 'text-primary-500' : 'text-gray-400'}" />
						{item.label}
					</a>
				</li>
			{/each}
		</ul>

		<div class="my-5 border-t border-line"></div>

		<p class="mb-2 section-label">Others</p>
		<ul class="space-y-0.5">
			{#each others as item (item.href)}
				{@const on = active(item.href)}
				<li>
					<a
						href={item.href}
						onclick={onnavigate}
						aria-current={on ? 'page' : undefined}
						class="flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13.5px] font-medium transition-colors {on
							? 'bg-primary-50 text-primary-600'
							: 'text-gray-600 hover:bg-canvas hover:text-ink'}"
					>
						<item.icon class="size-[18px] {on ? 'text-primary-500' : 'text-gray-400'}" />
						{item.label}
					</a>
				</li>
			{/each}
		</ul>
	</nav>

	<div class="p-4">
		<WorkspaceCard />
	</div>
</aside>
