<script lang="ts">
	import { goto } from '$app/navigation';
	import { navigating, page } from '$app/state';
	import { LoaderCircle } from '@lucide/svelte';
	import ActionButton from '#lib/components/ActionButton.svelte';
	import Card from '#lib/components/Card.svelte';
	import Confirm from '#lib/components/Confirm.svelte';
	import Drawer from '#lib/components/Drawer.svelte';
	import Empty from '#lib/components/Empty.svelte';
	import Pill from '#lib/components/Pill.svelte';
	import Time from '#lib/components/Time.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const isSelf = $derived(data.user?.user.id === page.data.admin.id);
	const LIMIT = 100;

	let typing = $state(false);
	let timer: ReturnType<typeof setTimeout>;
	function search(value: string) {
		clearTimeout(timer);
		typing = true;
		timer = setTimeout(async () => {
			const url = new URL(page.url.href);
			if (value) url.searchParams.set('q', value);
			else url.searchParams.delete('q');
			url.searchParams.delete('user');
			url.searchParams.delete('workspace');
			await goto(url, { replace: true, reset: false });
			typing = false;
		}, 250);
	}
	const searching = $derived(typing || navigating.to?.url.pathname === '/users');
	const count = $derived(data.view === 'users' ? data.users.length : data.workspaces.length);
	const noun = $derived(data.view === 'users' ? 'user' : 'workspace');

	const qs = (params: Record<string, string>) =>
		'?' +
		new URLSearchParams({
			...(data.view === 'workspaces' ? { view: 'workspaces' } : {}),
			...(data.q ? { q: data.q } : {}),
			...params
		});
</script>

<Card flush>
	<div class="flex flex-wrap items-center gap-3 p-4">
		<nav class="flex rounded-lg border border-line p-0.5 text-sm" aria-label="Show">
			<a
				href="/users"
				aria-current={data.view === 'users' ? 'page' : undefined}
				class="rounded-md px-3 py-1.5 aria-[current=page]:bg-primary-50 aria-[current=page]:font-medium aria-[current=page]:text-primary-700"
				>Users</a
			>
			<a
				href="/users?view=workspaces"
				aria-current={data.view === 'workspaces' ? 'page' : undefined}
				class="rounded-md px-3 py-1.5 aria-[current=page]:bg-primary-50 aria-[current=page]:font-medium aria-[current=page]:text-primary-700"
				>Workspaces</a
			>
		</nav>
		<div class="ml-auto flex items-center gap-3">
			<span class="flex items-center gap-1.5 text-xs text-muted" aria-live="polite">
				{#if searching}
					<LoaderCircle size={14} class="animate-spin" aria-hidden="true" /> Searching…
				{:else}
					{count === LIMIT ? `First ${LIMIT}` : count}
					{noun}{count === 1 ? '' : 's'}{data.q ? ` matching “${data.q}”` : ''}
				{/if}
			</span>
			<input
				class="input w-72 max-w-full"
				type="search"
				aria-label={data.view === 'users'
					? 'Search users by name or email'
					: 'Search workspaces by name or slug'}
				placeholder={data.view === 'users'
					? 'Search name or email'
					: 'Search workspace name or slug'}
				value={data.q}
				oninput={(e) => search(e.currentTarget.value)}
			/>
		</div>
	</div>

	{#if data.view === 'users'}
		{#if data.users.length}
			<div class="table-wrap">
				<table class="table">
					<thead>
						<tr
							><th>User</th><th>Status</th><th>Workspaces</th><th>Sessions</th><th>Last seen</th><th
								><span class="sr-only">Actions</span></th
							></tr
						>
					</thead>
					<tbody>
						{#each data.users as u (u.id)}
							<tr>
								<td>
									<p class="font-medium">{u.name}</p>
									<p class="text-xs text-muted">{u.email}</p>
								</td>
								<td>
									<span class="flex flex-wrap gap-1">
										{#if u.disabled}<Pill tone="bad">Disabled</Pill>{:else}<Pill tone="ok"
												>Active</Pill
											>{/if}
										{#if u.superadmin}<Pill tone="info">Superadmin</Pill>{/if}
									</span>
								</td>
								<td class="text-muted">{u.workspaces}</td>
								<td class="text-muted">{u.sessions}</td>
								<td class="whitespace-nowrap text-muted"><Time at={u.lastSeen} /></td>
								<td class="text-right">
									<a
										class="btn"
										href={qs({ user: u.id })}
										data-sveltekit-noscroll
										aria-label="View {u.name}">View</a
									>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<Empty
				title={data.q ? 'No matching users' : 'No users yet'}
				body={data.q ? 'Try a different name or email.' : undefined}
			>
				{#if data.q}<a class="btn" href="/users">Clear search</a>{/if}
			</Empty>
		{/if}
	{:else if data.workspaces.length}
		<div class="table-wrap">
			<table class="table">
				<thead
					><tr
						><th>Workspace</th><th>Kind</th><th>Members</th><th>Owner</th><th>Created</th><th
							><span class="sr-only">Actions</span></th
						></tr
					></thead
				>
				<tbody>
					{#each data.workspaces as w (w.id)}
						<tr>
							<td>
								<p class="font-medium">{w.name}</p>
								<p class="text-xs text-muted">{w.slug}</p>
							</td>
							<td class="text-muted capitalize">{w.kind ?? 'org'}</td>
							<td class="text-muted">{w.members}</td>
							<td class="text-muted">{w.owner ?? '—'}</td>
							<td class="whitespace-nowrap text-muted"><Time at={w.createdAt} /></td>
							<td class="text-right">
								<a
									class="btn"
									href={qs({ workspace: w.id })}
									data-sveltekit-noscroll
									aria-label="View {w.name}">View</a
								>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<Empty
			title={data.q ? 'No matching workspaces' : 'No workspaces yet'}
			body={data.q ? 'Try a different name or slug.' : undefined}
		>
			{#if data.q}<a class="btn" href="/users?view=workspaces">Clear search</a>{/if}
		</Empty>
	{/if}
</Card>

<Drawer param="user" title={data.user?.user.name ?? 'User'}>
	{#if data.user}
		{@const u = data.user.user}
		<p class="text-sm text-muted">{u.email}</p>
		<dl class="mt-3">
			<div class="detail">
				<dt>Account</dt>
				<dd class="flex flex-wrap gap-1.5">
					{#if u.disabled}<Pill tone="bad">Disabled</Pill>{:else}<Pill tone="ok">Active</Pill>{/if}
					<Pill tone={u.twoFactor ? 'ok' : 'neutral'}>2FA {u.twoFactor ? 'on' : 'off'}</Pill>
					{#if u.superadmin}<Pill tone="info">Superadmin</Pill>{/if}
				</dd>
			</div>
			<div class="detail">
				<dt>Joined</dt>
				<dd><Time at={u.createdAt} full /></dd>
			</div>
			<div class="detail">
				<dt>Workspaces</dt>
				<dd>
					{#each data.user.memberships as m (m.id)}
						<a class="block hover:underline" href="?view=workspaces&workspace={m.id}"
							>{m.name} <span class="text-muted">· {m.role}</span></a
						>
					{:else}<span class="text-muted">None</span>{/each}
				</dd>
			</div>
			<div class="detail">
				<dt>Active sessions ({data.user.sessions.length})</dt>
				<dd class="space-y-1.5">
					{#each data.user.sessions as s (s.id)}
						<p class="text-xs">
							<span class="font-medium">{s.ipAddress ?? 'Unknown IP'}</span>
							<span class="text-muted">· last used <Time at={s.updatedAt} /></span>
							<span class="block truncate text-muted" title={s.userAgent ?? ''}
								>{s.userAgent ?? ''}</span
							>
						</p>
					{:else}<span class="text-muted">None</span>{/each}
				</dd>
			</div>
		</dl>
		<div class="mt-5 flex flex-wrap gap-2">
			{#if data.user.sessions.length}
				<Confirm
					action="?/revokeSessions"
					fields={{ user: u.id }}
					title="Sign {u.name} out everywhere?"
					impact="All {data.user.sessions.length} active sessions end immediately{isSelf
						? ', including this one, so you will be signed out of the admin panel'
						: ''}. They can sign in again."
					confirmLabel="Revoke sessions"
					success="Signed {u.name} out of every session."
				>
					Revoke sessions
				</Confirm>
			{/if}
			{#if u.disabled}
				<ActionButton
					action="?/enable"
					fields={{ user: u.id }}
					success="{u.name} re-enabled. They can sign in again."
				>
					Enable account
				</ActionButton>
			{:else if !isSelf}
				<Confirm
					action="?/disable"
					fields={{ user: u.id }}
					title="Disable {u.name}?"
					impact="They are signed out of every session and can't sign in to any workspace until re-enabled. Their data is kept."
					confirmLabel="Disable account"
					success="{u.name} disabled and signed out everywhere."
				>
					Disable account
				</Confirm>
			{/if}
		</div>
		{#if isSelf && !u.disabled}
			<p class="mt-3 text-xs text-muted">
				This is your account. You can’t disable it from here, so the panel always has at least one
				admin who can sign in.
			</p>
		{/if}
	{/if}
</Drawer>

<Drawer param="workspace" title={data.workspace?.workspace.name ?? 'Workspace'}>
	{#if data.workspace}
		{@const w = data.workspace.workspace}
		<p class="text-sm text-muted">{w.slug} · <span class="capitalize">{w.kind ?? 'org'}</span></p>
		<dl class="mt-3">
			<div class="detail">
				<dt>Created</dt>
				<dd><Time at={w.createdAt} full /></dd>
			</div>
			<div class="detail">
				<dt>Members ({data.workspace.members.length})</dt>
				<dd class="space-y-1">
					{#each data.workspace.members as m (m.id)}
						<a class="block hover:underline" href="?user={m.id}"
							>{m.name} <span class="text-muted">· {m.email} · {m.role}</span></a
						>
					{/each}
				</dd>
			</div>
		</dl>
	{/if}
</Drawer>
