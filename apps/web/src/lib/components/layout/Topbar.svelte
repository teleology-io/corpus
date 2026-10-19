<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { DropdownMenu } from 'bits-ui';
	import {
		LogOut,
		Menu,
		Settings,
		Share2,
		ShieldCheck,
		ChevronDown,
		Sun,
		Moon,
		Monitor,
		Check
	} from '@lucide/svelte';
	import { theme, type ThemePref } from '#lib/stores/theme.svelte.js';
	import { authClient } from '@corpus/auth/client';
	import Avatar from '../ui/Avatar.svelte';
	import NotificationBell from './NotificationBell.svelte';
	import { toast } from '#lib/stores/toast.svelte.js';

	let { onmenu }: { onmenu: () => void } = $props();
	const themes = [
		['light', 'Light', Sun],
		['dark', 'Dark', Moon],
		['system', 'System', Monitor]
	] as const satisfies readonly (readonly [ThemePref, string, unknown])[];
	const user = $derived(page.data.user);

	async function share() {
		await navigator.clipboard.writeText(page.url.href);
		toast('Link copied', { tone: 'success', body: 'Anyone in this workspace can open it.' });
	}

	async function signOut() {
		await authClient.signOut();
		await goto('/sign-in');
	}
</script>

<header
	class="flex h-[72px] shrink-0 items-center gap-3 border-b border-line bg-surface px-4 lg:px-8"
>
	<button class="btn-icon lg:hidden" onclick={onmenu} aria-label="Open menu"
		><Menu class="size-5" /></button
	>
	<h1 class="truncate text-xl font-semibold tracking-tight text-ink">
		{page.data.title ?? 'Corpus'}
	</h1>

	<div class="ml-auto flex items-center gap-1.5">
		<button class="btn-icon" onclick={share} aria-label="Copy link to this page"
			><Share2 class="size-5" /></button
		>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger class="btn-icon" aria-label="Theme">
				{#if theme.dark}<Moon class="size-5" />{:else}<Sun class="size-5" />{/if}
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content class="menu w-40" align="end" sideOffset={8}>
					{#each themes as [value, label, Icon] (value)}
						<DropdownMenu.Item class="menu-item" onSelect={() => theme.set(value)}>
							<Icon class="size-4 text-muted" /><span class="flex-1">{label}</span>
							{#if theme.pref === value}<Check class="size-3.5 text-primary-500" />{/if}
						</DropdownMenu.Item>
					{/each}
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
		<NotificationBell />
		<div class="mx-2 hidden h-8 w-px bg-line sm:block"></div>
		{#if user}
			<DropdownMenu.Root>
				<DropdownMenu.Trigger class="flex items-center gap-3 rounded-lg p-1 pr-2 hover:bg-canvas">
					<Avatar name={user.name} image={user.image} size={38} />
					<span class="hidden text-left sm:block">
						<span class="block text-sm leading-tight font-semibold text-ink">{user.name}</span>
						<span class="block max-w-44 truncate text-xs text-muted">{user.email}</span>
					</span>
					<ChevronDown class="hidden size-4 text-muted sm:block" />
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Content class="menu w-52" align="end" sideOffset={8}>
						<DropdownMenu.Item class="menu-item" onSelect={() => goto('/settings')}
							><Settings class="size-4 text-muted" /> Settings</DropdownMenu.Item
						>
						<DropdownMenu.Item class="menu-item" onSelect={() => goto('/security')}
							><ShieldCheck class="size-4 text-muted" /> Security</DropdownMenu.Item
						>
						<DropdownMenu.Separator class="my-1 h-px bg-line" />
						<DropdownMenu.Item class="menu-item text-red-600" onSelect={signOut}
							><LogOut class="size-4" /> Sign out</DropdownMenu.Item
						>
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
		{/if}
	</div>
</header>
