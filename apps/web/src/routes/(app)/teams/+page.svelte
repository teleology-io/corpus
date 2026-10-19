<script lang="ts">
	import { onMount } from 'svelte';
	import { goto, refreshAll } from '$app/navigation';
	import { DropdownMenu } from 'bits-ui';
	import {
		Building2,
		Users,
		House,
		Plus,
		Mail,
		Trash2,
		UserPlus,
		X,
		LogOut,
		MailOpen,
		Check
	} from '@lucide/svelte';
	import { authClient } from '@corpus/auth/client';
	import Modal from '#lib/components/ui/Modal.svelte';
	import Avatar from '#lib/components/ui/Avatar.svelte';
	import AvatarStack from '#lib/components/ui/AvatarStack.svelte';
	import EmptyState from '#lib/components/ui/EmptyState.svelte';
	import { toast } from '#lib/stores/toast.svelte.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const isPersonal = $derived(data.org?.kind === 'personal');
	const isAdmin = $derived(data.myRole === 'owner' || data.myRole === 'admin');
	const orgId = $derived(data.org?.id ?? '');

	let createOpen = $state(false);
	let createKind = $state<'org' | 'family'>('org');
	let createName = $state('');
	let inviteEmail = $state('');
	let inviteRole = $state<'member' | 'admin'>('member');
	let inviteTeam = $state('');
	let teamName = $state('');
	let busy = $state(false);

	onMount(() => {
		if (data.openCreate) createOpen = true;
	});

	/** Run a Better Auth client call; toast on error, refresh on success. */
	async function run(fn: () => Promise<{ error: { message?: string } | null }>, success?: string) {
		busy = true;
		const res = await fn();
		busy = false;
		if (res.error) {
			toast('Something went wrong', { tone: 'error', body: res.error.message });
			return false;
		}
		if (success) toast(success, { tone: 'success' });
		await refreshAll();
		return true;
	}

	async function create(e: SubmitEvent) {
		e.preventDefault();
		const name = createName.trim();
		if (!name) return;
		const slug = `${name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '')}-${Math.random().toString(36).slice(2, 7)}`;
		busy = true;
		const res = await authClient.organization.create({ name, slug, kind: createKind });
		if (res.error || !res.data) {
			busy = false;
			return toast('Could not create workspace', { tone: 'error', body: res.error?.message });
		}
		await authClient.organization.setActive({ organizationId: res.data.id });
		busy = false;
		createOpen = false;
		createName = '';
		toast(`${name} created`, { tone: 'success', body: 'Invite people to get started.' });
		await goto('/teams', { refreshAll: true });
	}

	async function invite(e: SubmitEvent) {
		e.preventDefault();
		const email = inviteEmail.trim();
		if (!email) return;
		const ok = await run(
			() =>
				authClient.organization.inviteMember({
					email,
					role: inviteRole,
					organizationId: orgId,
					...(inviteTeam ? { teamId: inviteTeam } : {})
				}),
			`Invitation sent to ${email}`
		);
		if (ok) inviteEmail = '';
	}

	async function createTeam(e: SubmitEvent) {
		e.preventDefault();
		if (!teamName.trim()) return;
		if (
			await run(
				() => authClient.organization.createTeam({ name: teamName.trim(), organizationId: orgId }),
				'Team created'
			)
		)
			teamName = '';
	}

	async function leave() {
		if (!confirm(`Leave ${data.org?.name}?`)) return;
		if (await run(() => authClient.organization.leave({ organizationId: orgId })))
			await switchPersonal();
	}

	async function destroy() {
		if (
			!confirm(
				`Delete ${data.org?.name} and all of its calendars, notes and tasks? This cannot be undone.`
			)
		)
			return;
		if (await run(() => authClient.organization.delete({ organizationId: orgId })))
			await switchPersonal();
	}

	async function switchPersonal() {
		const personal = data.workspaces.find((w) => w.kind === 'personal');
		if (personal) await authClient.organization.setActive({ organizationId: personal.id });
		await goto('/dashboard', { refreshAll: true });
	}

	const kindIcon = { org: Building2, family: House, personal: Users } as const;
	const membersById = $derived(new Map(data.members.map((m) => [m.id, m])));
</script>

<svelte:head><title>Teams · Corpus</title></svelte:head>

<div class="space-y-6 p-4 lg:p-8">
	{#if data.invitations.length}
		<section class="card border-primary-200 bg-primary-50/40 p-4">
			<h3 class="mb-2 flex items-center gap-2 text-sm font-semibold">
				<MailOpen class="size-4 text-primary-500" /> Invitations for you
			</h3>
			<ul class="divide-y divide-line">
				{#each data.invitations as inv (inv.id)}
					<li class="flex items-center gap-3 py-2 text-sm">
						<span class="flex-1"
							><b>{inv.inviterName}</b> invited you to <b>{inv.orgName}</b> as {inv.role}</span
						>
						<a class="btn-primary h-8 text-xs" href="/teams/invite/{inv.id}">Review</a>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if isPersonal}
		<section class="card">
			<EmptyState
				title="This is your personal workspace"
				body="Create an organization for work, or a family to share calendars, reminders and notes with the people you live with. You can switch workspaces any time from the sidebar."
			>
				{#snippet icon()}<Users class="size-5" />{/snippet}
				{#snippet action()}
					<div class="flex flex-wrap justify-center gap-2">
						<button class="btn-primary" onclick={() => ((createKind = 'org'), (createOpen = true))}
							><Building2 class="size-4" /> Create organization</button
						>
						<button
							class="btn-outline"
							onclick={() => ((createKind = 'family'), (createOpen = true))}
							><House class="size-4" /> Create family</button
						>
					</div>
				{/snippet}
			</EmptyState>
		</section>

		{#if data.workspaces.length > 1}
			<section>
				<h3 class="mb-3 font-semibold">Your workspaces</h3>
				<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
					{#each data.workspaces.filter((w) => w.kind !== 'personal') as w (w.id)}
						{@const K = kindIcon[(w.kind ?? 'org') as keyof typeof kindIcon] ?? Building2}
						<button
							class="flex items-center gap-3 card p-4 text-left hover:shadow-pop"
							onclick={async () => {
								await authClient.organization.setActive({ organizationId: w.id });
								await refreshAll();
							}}
						>
							<span
								class="flex size-10 items-center justify-center rounded-xl bg-primary-50 text-primary-500"
								><K class="size-5" /></span
							>
							<span class="min-w-0 flex-1"
								><span class="block truncate font-medium">{w.name}</span><span
									class="text-xs text-muted capitalize">{w.kind} · {w.role}</span
								></span
							>
						</button>
					{/each}
				</div>
			</section>
		{/if}
	{:else if data.org}
		{@const K = kindIcon[data.org.kind as keyof typeof kindIcon] ?? Building2}
		<div class="flex flex-wrap items-center gap-3">
			<span class="flex size-11 items-center justify-center rounded-xl bg-primary-500 text-white"
				><K class="size-5" /></span
			>
			<div>
				<h2 class="text-lg font-semibold">{data.org.name}</h2>
				<p class="text-sm text-muted capitalize">
					{data.org.kind === 'org' ? 'Organization' : data.org.kind} · {data.members.length} member{data
						.members.length === 1
						? ''
						: 's'} · you are {data.myRole}
				</p>
			</div>
			<div class="ml-auto flex gap-2">
				<button class="btn-outline" onclick={() => ((createKind = 'org'), (createOpen = true))}
					><Plus class="size-4" /> New workspace</button
				>
			</div>
		</div>

		<div class="grid gap-4 xl:grid-cols-3">
			<section class="card xl:col-span-2">
				<div class="flex items-center border-b border-line px-4 py-3">
					<h3 class="font-semibold">Members</h3>
				</div>
				{#if isAdmin}
					<form class="flex flex-wrap gap-2 border-b border-line p-4" onsubmit={invite}>
						<div class="relative min-w-48 flex-1">
							<Mail
								class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
							/>
							<input
								class="input pl-9"
								type="email"
								placeholder="name@example.com"
								bind:value={inviteEmail}
								required
							/>
						</div>
						<select class="input w-28" bind:value={inviteRole}>
							<option value="member">Member</option>
							<option value="admin">Admin</option>
						</select>
						{#if data.teams.length}
							<select class="input w-36" bind:value={inviteTeam}>
								<option value="">No team</option>
								{#each data.teams as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
							</select>
						{/if}
						<button class="btn-primary h-10" disabled={busy}
							><UserPlus class="size-4" /> Invite</button
						>
					</form>
				{/if}
				<ul class="divide-y divide-line">
					{#each data.members as m (m.memberId)}
						<li class="flex items-center gap-3 px-4 py-3">
							<Avatar name={m.name} image={m.image} size={34} />
							<div class="min-w-0 flex-1">
								<p class="truncate text-sm font-medium">
									{m.name}{m.id === data.user.id ? ' (you)' : ''}
								</p>
								<p class="truncate text-xs text-muted">{m.email}</p>
							</div>
							{#if isAdmin && m.role !== 'owner' && m.id !== data.user.id}
								<select
									class="input h-8 w-28 text-xs"
									value={m.role}
									onchange={(e) =>
										run(
											() =>
												authClient.organization.updateMemberRole({
													memberId: m.memberId,
													role: e.currentTarget.value as 'member' | 'admin',
													organizationId: orgId
												}),
											'Role updated'
										)}
								>
									<option value="member">Member</option>
									<option value="admin">Admin</option>
								</select>
								<button
									class="btn-icon size-8 hover:text-red-600"
									aria-label="Remove member"
									onclick={() =>
										confirm(`Remove ${m.name}?`) &&
										run(
											() =>
												authClient.organization.removeMember({
													memberIdOrEmail: m.memberId,
													organizationId: orgId
												}),
											'Member removed'
										)}
								>
									<Trash2 class="size-4" />
								</button>
							{:else}
								<span class="chip bg-canvas text-muted capitalize">{m.role}</span>
							{/if}
						</li>
					{/each}
				</ul>
				{#if data.pending.length}
					<div class="border-t border-line px-4 py-3">
						<p class="mb-2 text-xs font-semibold text-muted">Pending invitations</p>
						<ul class="space-y-1.5">
							{#each data.pending as p (p.id)}
								<li class="flex items-center gap-2 text-sm">
									<Mail class="size-3.5 text-muted" /><span class="flex-1 truncate">{p.email}</span
									><span class="text-xs text-muted capitalize">{p.role}</span>
									{#if isAdmin}<button
											class="btn-icon size-7"
											aria-label="Cancel invitation"
											onclick={() =>
												run(
													() => authClient.organization.cancelInvitation({ invitationId: p.id }),
													'Invitation cancelled'
												)}><X class="size-3.5" /></button
										>{/if}
								</li>
							{/each}
						</ul>
					</div>
				{/if}
			</section>

			<section class="card">
				<div class="border-b border-line px-4 py-3">
					<h3 class="font-semibold">Teams</h3>
					<p class="text-xs text-muted">Groups for sharing notes and calendars.</p>
				</div>
				<ul class="divide-y divide-line">
					{#each data.teams as t (t.id)}
						<li class="px-4 py-3">
							<div class="flex items-center gap-2">
								<span class="flex-1 truncate text-sm font-medium">{t.name}</span>
								{#if isAdmin}
									<DropdownMenu.Root>
										<DropdownMenu.Trigger class="btn-icon size-7" aria-label="Add to team"
											><UserPlus class="size-3.5" /></DropdownMenu.Trigger
										>
										<DropdownMenu.Portal>
											<DropdownMenu.Content class="menu w-56" align="end" sideOffset={4}>
												{#each data.members as m (m.id)}
													{@const inTeam = t.memberIds.includes(m.id)}
													<DropdownMenu.Item
														class="menu-item"
														onSelect={() =>
															run(() =>
																inTeam
																	? authClient.organization.removeTeamMember({
																			teamId: t.id,
																			userId: m.id
																		})
																	: authClient.organization.addTeamMember({
																			teamId: t.id,
																			userId: m.id
																		})
															)}
													>
														<Avatar name={m.name} image={m.image} size={20} /><span
															class="flex-1 truncate">{m.name}</span
														>
														{#if inTeam}<Check class="size-3.5 text-primary-500" />{/if}
													</DropdownMenu.Item>
												{/each}
											</DropdownMenu.Content>
										</DropdownMenu.Portal>
									</DropdownMenu.Root>
									<button
										class="btn-icon size-7 hover:text-red-600"
										aria-label="Delete team"
										onclick={() =>
											confirm(`Delete team ${t.name}?`) &&
											run(() =>
												authClient.organization.removeTeam({ teamId: t.id, organizationId: orgId })
											)}><Trash2 class="size-3.5" /></button
									>
								{/if}
							</div>
							<div class="mt-1.5">
								{#if t.memberIds.length}
									<AvatarStack
										people={t.memberIds
											.map((id) => membersById.get(id))
											.filter((m) => !!m)
											.map((m) => ({ id: m!.id, name: m!.name, image: m!.image }))}
										max={6}
									/>
								{:else}<p class="text-xs text-muted">No members yet</p>{/if}
							</div>
						</li>
					{:else}
						<li class="px-4 py-6 text-center text-xs text-muted">No teams yet</li>
					{/each}
				</ul>
				{#if isAdmin}
					<form class="flex gap-2 border-t border-line p-3" onsubmit={createTeam}>
						<input class="input h-9" placeholder="New team name" bind:value={teamName} />
						<button class="btn-outline h-9" disabled={busy}><Plus class="size-4" /></button>
					</form>
				{/if}
			</section>
		</div>

		<section class="flex flex-wrap items-center gap-3 card p-4">
			<div class="flex-1">
				<p class="text-sm font-semibold">
					{data.myRole === 'owner' ? 'Delete workspace' : 'Leave workspace'}
				</p>
				<p class="text-xs text-muted">
					{data.myRole === 'owner'
						? 'Permanently removes all calendars, notes and tasks in this workspace.'
						: 'You will lose access to shared calendars and notes.'}
				</p>
			</div>
			{#if data.myRole === 'owner'}
				<button class="btn-danger" onclick={destroy}><Trash2 class="size-4" /> Delete</button>
			{:else}
				<button class="btn-outline text-red-600" onclick={leave}
					><LogOut class="size-4" /> Leave</button
				>
			{/if}
		</section>
	{/if}
</div>

<Modal
	bind:open={createOpen}
	title={createKind === 'family' ? 'Create a family' : 'Create an organization'}
	description="You'll be the owner and can invite others"
	size="sm"
>
	{#snippet icon()}{#if createKind === 'family'}<House class="size-5" />{:else}<Building2
				class="size-5"
			/>{/if}{/snippet}
	<form id="create-ws" class="space-y-4" onsubmit={create}>
		<div class="grid grid-cols-2 gap-2">
			{#each [['org', 'Organization', Building2], ['family', 'Family', House]] as const as [k, label, I] (k)}
				<button
					type="button"
					class="flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm {createKind === k
						? 'border-primary-500 bg-primary-50 text-primary-700'
						: 'border-line'}"
					onclick={() => (createKind = k)}
				>
					<I class="size-4" />{label}
				</button>
			{/each}
		</div>
		<div>
			<label class="label" for="ws-name">Name</label>
			<input
				id="ws-name"
				class="input"
				placeholder={createKind === 'family' ? 'The Smiths' : 'Acme Inc.'}
				bind:value={createName}
				required
			/>
		</div>
	</form>
	{#snippet footer()}
		<div class="ml-auto flex gap-2">
			<button class="btn-outline" onclick={() => (createOpen = false)}>Cancel</button>
			<button class="btn-primary" form="create-ws" disabled={busy}>Create</button>
		</div>
	{/snippet}
</Modal>
