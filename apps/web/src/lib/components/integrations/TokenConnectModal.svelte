<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { ExternalLink, KeyRound } from '@lucide/svelte';
	import Modal from '#lib/components/ui/Modal.svelte';
	import { api } from '#lib/api.js';
	import { attempt, toast } from '#lib/stores/toast.svelte.js';

	export interface TokenTarget {
		id: string;
		name: string;
		personalToken: { label: string; createUrl: string; hint: string };
	}

	let { open = $bindable(false), target }: { open?: boolean; target: TokenTarget | null } =
		$props();

	let token = $state('');
	let saving = $state(false);

	$effect(() => {
		if (open) token = '';
	});

	async function connect(e: SubmitEvent) {
		e.preventDefault();
		if (!target) return;
		saving = true;
		const ok = await attempt(
			() =>
				api('/api/integrations/token', {
					method: 'POST',
					body: { provider: target.id, token }
				}).then(() => true),
			'Could not connect'
		);
		saving = false;
		if (!ok) return;
		toast(`${target.name} connected`, { tone: 'success', body: 'Importing your items now…' });
		open = false;
		await invalidateAll();
	}
</script>

<Modal
	bind:open
	title="Connect {target?.name ?? ''} with a token"
	description="No OAuth app needed. The token is encrypted and only used to read your items."
	size="sm"
>
	{#snippet icon()}<KeyRound class="size-5" />{/snippet}
	{#if target}
		<form id="token-connect" class="space-y-3" onsubmit={connect}>
			<p class="text-xs text-muted">
				<a
					class="inline-flex items-center gap-1 font-medium text-primary-600 hover:underline"
					href={target.personalToken.createUrl}
					target="_blank"
					rel="noreferrer"
					>Create a {target.personalToken.label.toLowerCase()} <ExternalLink class="size-3" /></a
				>
				— {target.personalToken.hint}
			</p>
			<label class="block">
				<span class="label">{target.personalToken.label}</span>
				<input
					class="input font-mono text-xs"
					type="password"
					bind:value={token}
					required
					autocomplete="off"
				/>
			</label>
		</form>
	{/if}
	{#snippet footer()}
		<button class="ml-auto btn-outline" onclick={() => (open = false)}>Cancel</button>
		<button class="btn-primary" form="token-connect" disabled={saving || !token.trim()}
			>Connect</button
		>
	{/snippet}
</Modal>
