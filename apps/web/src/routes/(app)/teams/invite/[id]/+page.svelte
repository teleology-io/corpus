<script lang="ts">
	import { goto } from '$app/navigation';
	import { MailOpen } from '@lucide/svelte';
	import { authClient } from '@corpus/auth/client';
	import { toast } from '#lib/stores/toast.svelte.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let busy = $state(false);
	const usable = $derived(
		data.invite.status === 'pending' &&
			new Date(data.invite.expiresAt) > new Date() &&
			data.emailMatches
	);

	async function respond(accept: boolean) {
		busy = true;
		const res = accept
			? await authClient.organization.acceptInvitation({ invitationId: data.invite.id })
			: await authClient.organization.rejectInvitation({ invitationId: data.invite.id });
		busy = false;
		if (res.error) return toast('Could not respond', { tone: 'error', body: res.error.message });
		if (accept) {
			const orgId = (res.data as { invitation?: { organizationId?: string } } | null)?.invitation
				?.organizationId;
			if (orgId) await authClient.organization.setActive({ organizationId: orgId });
			toast(`Welcome to ${data.invite.orgName}`, { tone: 'success' });
			await goto('/teams', { refreshAll: true });
		} else await goto('/teams');
	}
</script>

<div class="mx-auto max-w-md p-8">
	<div class="card p-6 text-center">
		<span
			class="mx-auto flex size-12 items-center justify-center rounded-xl bg-primary-50 text-primary-500"
			><MailOpen class="size-6" /></span
		>
		<h2 class="mt-4 text-lg font-semibold">
			{data.invite.inviterName} invited you to {data.invite.orgName}
		</h2>
		<p class="mt-1 text-sm text-muted">
			Join as <span class="font-medium capitalize">{data.invite.role ?? 'member'}</span> of this {data
				.invite.orgKind === 'family'
				? 'family'
				: 'organization'}.
		</p>
		{#if usable}
			<div class="mt-6 flex justify-center gap-2">
				<button class="btn-outline" disabled={busy} onclick={() => respond(false)}>Decline</button>
				<button class="btn-primary" disabled={busy} onclick={() => respond(true)}
					>Accept invitation</button
				>
			</div>
		{:else if !data.emailMatches}
			<p class="mt-6 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
				This invitation was sent to {data.invite.email}. Sign in with that address to accept it.
			</p>
		{:else}
			<p class="mt-6 text-sm text-muted">
				This invitation is no longer valid ({data.invite.status}).
			</p>
		{/if}
	</div>
</div>
