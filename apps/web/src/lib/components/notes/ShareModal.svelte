<script lang="ts">
	import { page } from '$app/state';
	import { Share2, Link2, Trash2, Users, Copy } from '@lucide/svelte';
	import Modal from '../ui/Modal.svelte';
	import Avatar from '../ui/Avatar.svelte';
	import Switch from '../ui/Switch.svelte';
	import { api } from '#lib/api.js';
	import { attempt, toast } from '#lib/stores/toast.svelte.js';

	type Role = 'view' | 'comment' | 'edit';
	interface ShareData {
		shares: {
			id: string;
			role: string;
			userId: string | null;
			teamId: string | null;
			userName: string | null;
			userEmail: string | null;
			userImage: string | null;
			teamName: string | null;
		}[];
		links: { token: string; role: string }[];
		teams: { id: string; name: string }[];
	}

	let {
		open = $bindable(false),
		noteId,
		canEdit
	}: { open?: boolean; noteId: string; canEdit: boolean } = $props();

	let data = $state<ShareData | null>(null);
	let email = $state('');
	let role = $state<Role>('edit');
	let teamId = $state('');
	let linkRole = $state<Role>('view');

	$effect(() => {
		if (open) void load();
	});

	async function load() {
		data = (await attempt(() => api<ShareData>(`/api/notes/${noteId}/shares`))) ?? null;
		if (data?.links[0]) linkRole = data.links[0].role as Role;
	}

	async function invite(e: SubmitEvent) {
		e.preventDefault();
		if (!email.trim() && !teamId) return;
		const ok = await attempt(
			() =>
				api(`/api/notes/${noteId}/shares`, {
					body: email.trim() ? { email: email.trim(), role } : { teamId, role }
				}).then(() => true),
			'Could not share'
		);
		if (ok) {
			toast('Shared', { tone: 'success' });
			email = '';
			teamId = '';
			await load();
		}
	}

	async function removeShare(shareId: string) {
		await attempt(() =>
			api(`/api/notes/${noteId}/shares`, { method: 'DELETE', body: { shareId } })
		);
		await load();
	}

	async function setLink(on: boolean) {
		if (on) await attempt(() => api(`/api/notes/${noteId}/link`, { body: { role: linkRole } }));
		else await attempt(() => api(`/api/notes/${noteId}/link`, { method: 'DELETE' }));
		await load();
	}

	async function changeLinkRole() {
		if (data?.links.length) await setLink(true);
	}

	const linkUrl = $derived(
		data?.links[0] ? `${page.url.origin}/share/${data.links[0].token}` : null
	);
</script>

<Modal
	bind:open
	title="Share page"
	description="Invite people, share with a team, or publish a link"
	size="md"
>
	{#snippet icon()}<Share2 class="size-5" />{/snippet}
	{#if canEdit}
		<form class="flex gap-2" onsubmit={invite}>
			<input
				class="input flex-1"
				type="email"
				placeholder="Email address"
				bind:value={email}
				disabled={!!teamId}
			/>
			{#if data?.teams.length}
				<select class="input w-36" bind:value={teamId} disabled={!!email.trim()}>
					<option value="">or a team…</option>
					{#each data.teams as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
				</select>
			{/if}
			<select class="input w-28" bind:value={role}>
				<option value="view">Can view</option>
				<option value="comment">Can comment</option>
				<option value="edit">Can edit</option>
			</select>
			<button class="btn-primary h-10">Invite</button>
		</form>
		<p class="mt-1.5 text-xs text-muted">
			Members of this workspace can already edit. Sharing also applies to subpages.
		</p>
	{/if}

	<ul class="mt-4 divide-y divide-line">
		{#each data?.shares ?? [] as s (s.id)}
			<li class="flex items-center gap-3 py-2.5">
				{#if s.teamId}
					<span
						class="flex size-7 items-center justify-center rounded-full bg-primary-50 text-primary-600"
						><Users class="size-3.5" /></span
					>
					<span class="flex-1 text-sm font-medium"
						>{s.teamName} <span class="text-xs font-normal text-muted">team</span></span
					>
				{:else}
					<Avatar name={s.userName ?? '?'} image={s.userImage} size={28} />
					<span class="min-w-0 flex-1">
						<span class="block truncate text-sm font-medium">{s.userName}</span>
						<span class="block truncate text-xs text-muted">{s.userEmail}</span>
					</span>
				{/if}
				<span class="text-xs text-muted capitalize">{s.role}</span>
				{#if canEdit}<button
						class="btn-icon size-7 hover:text-red-600"
						aria-label="Remove"
						onclick={() => removeShare(s.id)}><Trash2 class="size-3.5" /></button
					>{/if}
			</li>
		{/each}
	</ul>

	<div class="mt-4 rounded-xl border border-line p-3">
		<div class="flex items-center gap-3">
			<span class="flex size-8 items-center justify-center rounded-lg bg-canvas"
				><Link2 class="size-4" /></span
			>
			<div class="flex-1">
				<p class="text-sm font-medium">Share to web</p>
				<p class="text-xs text-muted">
					Anyone with the link can {linkRole === 'edit' ? 'edit' : 'view'} — no account needed.
				</p>
			</div>
			{#if canEdit}<Switch checked={!!linkUrl} label="Public link" onchange={setLink} />{/if}
		</div>
		{#if linkUrl}
			<div class="mt-3 flex gap-2">
				<input class="input h-9 flex-1 text-xs" readonly value={linkUrl} />
				{#if canEdit}
					<select class="input h-9 w-28 text-xs" bind:value={linkRole} onchange={changeLinkRole}>
						<option value="view">Can view</option>
						<option value="edit">Can edit</option>
					</select>
				{/if}
				<button
					class="btn-outline h-9"
					onclick={() => (
						navigator.clipboard.writeText(linkUrl),
						toast('Link copied', { tone: 'success' })
					)}><Copy class="size-3.5" /></button
				>
			</div>
		{/if}
	</div>
</Modal>
