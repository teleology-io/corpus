<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import { DropdownMenu, Popover } from 'bits-ui';
	import { Share2, MoreHorizontal, Archive, Trash2, ChevronRight, Eye, Copy } from '@lucide/svelte';
	import NoteEditor from '#lib/components/notes/NoteEditor.svelte';
	import ShareModal from '#lib/components/notes/ShareModal.svelte';
	import Avatar from '#lib/components/ui/Avatar.svelte';
	import { EMOJI, colorFor } from '#lib/components/notes/presence.js';
	import { api } from '#lib/api.js';
	import { attempt, toast } from '#lib/stores/toast.svelte.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const canEdit = $derived(data.role === 'edit' || data.role === 'owner');
	let title = $state('');
	let icon = $state<string | null>(null);
	let shareOpen = $state(false);
	let status = $state<{
		connected: boolean;
		synced: boolean;
		peers: { name: string; color: string }[];
	}>({ connected: false, synced: false, peers: [] });

	// Seed local fields only when switching notes. Data reloads (tree invalidation, live
	// refreshes) carry the last *saved* title and would clobber what's being typed.
	let loadedId = '';
	$effect.pre(() => {
		if (data.note.id === loadedId) return;
		loadedId = data.note.id;
		title = data.note.title;
		icon = data.note.icon;
	});

	let titleTimer: ReturnType<typeof setTimeout>;
	function onTitle() {
		clearTimeout(titleTimer);
		const id = data.note.id;
		const value = title;
		titleTimer = setTimeout(async () => {
			await attempt(() => api(`/api/notes/${id}`, { method: 'PATCH', body: { title: value } }));
			await invalidate('app:notes-tree');
		}, 500);
	}

	async function setIcon(e: string | null) {
		icon = e;
		await attempt(() => api(`/api/notes/${data.note.id}`, { method: 'PATCH', body: { icon: e } }));
		await invalidate('app:notes-tree');
	}

	async function archive() {
		await attempt(() =>
			api(`/api/notes/${data.note.id}`, { method: 'PATCH', body: { archived: true } })
		);
		toast('Page archived', { tone: 'success' });
		await goto('/notes');
	}

	async function destroy() {
		if (!confirm('Delete this page and all of its subpages permanently?')) return;
		await attempt(() => api(`/api/notes/${data.note.id}`, { method: 'DELETE' }));
		await goto('/notes', { refreshAll: true });
	}

	async function duplicateLink() {
		await navigator.clipboard.writeText(`${location.origin}/notes/${data.note.id}`);
		toast('Link copied', { tone: 'success' });
	}

	const token = async () => {
		const res = await api<{ token: string }>(`/api/notes/${data.note.id}/token`);
		return res.token;
	};
	const others = $derived(status.peers.filter((p) => p.name !== data.user.name));
</script>

<svelte:head><title>{title || 'Untitled'} · Corpus</title></svelte:head>

<div
	class="sticky top-0 z-20 flex items-center gap-2 border-b border-line bg-surface/90 px-4 py-2.5 backdrop-blur lg:px-8"
>
	<nav class="flex min-w-0 items-center gap-1 text-[13px] text-muted">
		{#each data.crumbs as c, i (c.id)}
			{#if i > 0}<ChevronRight class="size-3.5 shrink-0" />{/if}
			<a
				href="/notes/{c.id}"
				class="truncate hover:text-ink {i === data.crumbs.length - 1 ? 'font-medium text-ink' : ''}"
				>{c.icon ?? ''} {c.id === data.note.id ? title || 'Untitled' : c.title || 'Untitled'}</a
			>
		{/each}
	</nav>
	<div class="ml-auto flex items-center gap-2">
		<span
			class="flex items-center gap-1.5 text-[11px] text-muted"
			title={status.connected ? 'Live' : 'Connecting…'}
		>
			<span
				class="size-2 rounded-full {status.connected
					? status.synced
						? 'bg-emerald-500'
						: 'bg-amber-400'
					: 'bg-gray-300'}"
			></span>
			{status.connected ? (status.synced ? 'Live' : 'Syncing') : 'Offline'}
		</span>
		{#if others.length}
			<div class="flex -space-x-1.5">
				{#each others.slice(0, 4) as p, i (p.name + i)}
					<span class="rounded-full ring-2" style:--tw-ring-color={p.color}
						><Avatar name={p.name} size={24} /></span
					>
				{/each}
			</div>
		{/if}
		{#if !canEdit}<span class="chip bg-canvas text-muted"><Eye class="size-3" /> View only</span
			>{/if}
		<button class="btn-outline h-8 text-xs" onclick={() => (shareOpen = true)}
			><Share2 class="size-3.5" /> Share</button
		>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger class="btn-icon size-8" aria-label="More"
				><MoreHorizontal class="size-4" /></DropdownMenu.Trigger
			>
			<DropdownMenu.Portal>
				<DropdownMenu.Content class="menu w-48" align="end" sideOffset={6}>
					<DropdownMenu.Item class="menu-item" onSelect={duplicateLink}
						><Copy class="size-4 text-muted" /> Copy link</DropdownMenu.Item
					>
					{#if canEdit}
						<DropdownMenu.Item class="menu-item" onSelect={archive}
							><Archive class="size-4 text-muted" /> Archive</DropdownMenu.Item
						>
						<DropdownMenu.Item class="menu-item text-red-600" onSelect={destroy}
							><Trash2 class="size-4" /> Delete</DropdownMenu.Item
						>
					{/if}
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	</div>
</div>

<article class="mx-auto max-w-3xl px-6 pt-10 pb-32 lg:px-10">
	<div class="pl-6">
		<Popover.Root>
			<Popover.Trigger
				class="mb-2 rounded-lg p-1 text-5xl leading-none hover:bg-canvas disabled:hover:bg-transparent"
				disabled={!canEdit}
				aria-label="Change icon"
			>
				{icon ?? '📄'}
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content class="menu grid w-72 grid-cols-8 gap-1 p-2" sideOffset={4} align="start">
					{#each EMOJI as e (e)}
						<button class="rounded-md p-1 text-xl hover:bg-canvas" onclick={() => setIcon(e)}
							>{e}</button
						>
					{/each}
					<button
						class="col-span-8 mt-1 rounded-md py-1 text-xs text-muted hover:bg-canvas"
						onclick={() => setIcon(null)}>Remove</button
					>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
		<input
			class="w-full bg-transparent text-4xl font-bold tracking-tight outline-none placeholder:text-gray-300"
			placeholder="Untitled"
			bind:value={title}
			oninput={onTitle}
			readonly={!canEdit}
		/>
	</div>
	<div class="mt-6">
		{#key data.note.id}
			<NoteEditor
				noteId={data.note.id}
				collabUrl={data.config.collabUrl}
				{token}
				user={{ name: data.user.name, color: colorFor(data.user.id) }}
				members={data.members}
				editable={canEdit}
				onstatus={(s) => (status = s)}
			/>
		{/key}
	</div>
</article>

<ShareModal bind:open={shareOpen} noteId={data.note.id} {canEdit} />
