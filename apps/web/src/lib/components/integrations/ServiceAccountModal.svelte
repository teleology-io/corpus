<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { ExternalLink, FileKey } from '@lucide/svelte';
	import Modal from '#lib/components/ui/Modal.svelte';
	import { api } from '#lib/api.js';
	import { attempt, toast } from '#lib/stores/toast.svelte.js';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	const SCOPE = 'https://www.googleapis.com/auth/calendar';

	let credentials = $state('');
	let subject = $state('');
	let saving = $state(false);

	$effect(() => {
		if (open) credentials = subject = '';
	});

	// Client-side peek so the user sees which account the key belongs to (server re-validates).
	const parsed = $derived.by(() => {
		if (!credentials.trim()) return null;
		try {
			const d = JSON.parse(credentials);
			if (d.type !== 'service_account' || !d.client_email || !d.private_key)
				return { error: 'Not a service account key file' };
			return { email: d.client_email as string };
		} catch {
			return { error: 'Not valid JSON' };
		}
	});

	async function pick(e: Event) {
		const file = (e.currentTarget as HTMLInputElement).files?.[0];
		if (file) credentials = await file.text();
	}

	async function connect(e: SubmitEvent) {
		e.preventDefault();
		saving = true;
		const ok = await attempt(
			() =>
				api('/api/integrations/service-account', {
					body: { credentials, subject: subject.trim() || null }
				}).then(() => true),
			'Could not connect'
		);
		saving = false;
		if (!ok) return;
		toast('Google Calendar connected', {
			tone: 'success',
			body: subject.trim()
				? 'Syncing the primary calendar — pick more below.'
				: 'Share calendars with the service account, then add them below.'
		});
		open = false;
		await invalidateAll();
	}
</script>

<Modal
	bind:open
	title="Connect Google Calendar with a service account"
	description="No OAuth app needed. The key is encrypted and only used to sync your calendars."
	size="md"
>
	{#snippet icon()}<FileKey class="size-5" />{/snippet}
	<form id="sa-connect" class="space-y-4" onsubmit={connect}>
		<p class="text-xs text-muted">
			<a
				class="inline-flex items-center gap-1 font-medium text-primary-600 hover:underline"
				href="https://console.cloud.google.com/iam-admin/serviceaccounts"
				target="_blank"
				rel="noreferrer">Create a service account key <ExternalLink class="size-3" /></a
			>
			— Keys → Add key → JSON. Enable the Google Calendar API in the same project.
		</p>
		<label class="block">
			<span class="label">Key file</span>
			<input
				class="block w-full text-xs file:mr-3 file:btn-outline file:h-8 file:text-xs"
				type="file"
				accept=".json,application/json"
				onchange={pick}
			/>
		</label>
		<label class="block">
			<span class="label">…or paste the JSON</span>
			<textarea
				class="input h-28 font-mono text-[11px]"
				bind:value={credentials}
				spellcheck="false"
				autocomplete="off"
				placeholder={'{ "type": "service_account", … }'}></textarea>
		</label>
		{#if parsed?.error}
			<p class="text-xs text-red-600">{parsed.error}</p>
		{:else if parsed?.email}
			<p class="text-xs text-muted">
				Service account: <span class="font-medium break-all text-ink">{parsed.email}</span>
			</p>
		{/if}
		<label class="block">
			<span class="label">Impersonate user (optional)</span>
			<input
				class="input"
				type="email"
				bind:value={subject}
				placeholder="you@yourcompany.com"
				autocomplete="off"
			/>
			<span class="mt-1 block text-xs text-muted">
				Google Workspace only: requires
				<a
					class="font-medium text-primary-600 hover:underline"
					href="https://admin.google.com/ac/owl/domainwidedelegation"
					target="_blank"
					rel="noreferrer">domain-wide delegation</a
				>
				for <code class="break-all">{SCOPE}</code>. Leave blank to sync calendars shared with the
				service account instead.
			</span>
		</label>
	</form>
	{#snippet footer()}
		<button class="ml-auto btn-outline" onclick={() => (open = false)}>Cancel</button>
		<button class="btn-primary" form="sa-connect" disabled={saving || !parsed?.email}
			>Connect</button
		>
	{/snippet}
</Modal>
