<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { Copy, ExternalLink, KeyRound } from '@lucide/svelte';
	import Modal from '#lib/components/ui/Modal.svelte';
	import { api } from '#lib/api.js';
	import { attempt, toast } from '#lib/stores/toast.svelte.js';

	export interface AppTarget {
		id: string;
		name: string;
		app: {
			source: 'env' | 'db' | null;
			clientId: string | null;
			envPrefix: string;
			redirectUri: string;
			setupUrl: string | null;
		};
	}

	let { open = $bindable(false), target }: { open?: boolean; target: AppTarget | null } = $props();

	let clientId = $state('');
	let clientSecret = $state('');
	let saving = $state(false);

	$effect(() => {
		if (open && target) {
			clientId = target.app.clientId ?? '';
			clientSecret = '';
		}
	});

	const HINTS: Record<string, string> = {
		github: 'New OAuth App → paste the callback URL as "Authorization callback URL".',
		linear: 'New application → add the callback URL under "Callback URLs".',
		'google-calendar':
			'Create an OAuth client of type "Web application", add the callback URL as an authorized redirect URI, and enable the Google Calendar API.',
		slack:
			'Create an app → OAuth & Permissions → add the callback URL as a redirect URL (Slack requires https).'
	};

	async function copy() {
		if (!target) return;
		await navigator.clipboard.writeText(target.app.redirectUri);
		toast('Callback URL copied', { tone: 'success' });
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (!target) return;
		saving = true;
		const ok = await attempt(() =>
			api(`/api/integrations/apps/${target.id}`, {
				method: 'PUT',
				body: { clientId, clientSecret }
			}).then(() => true)
		);
		saving = false;
		if (!ok) return;
		toast(`${target.name} is ready to connect`, { tone: 'success' });
		open = false;
		await invalidateAll();
	}

	async function remove() {
		if (!target) return;
		if (!confirm(`Remove the ${target.name} OAuth app? Existing connections may stop syncing.`))
			return;
		await attempt(() => api(`/api/integrations/apps/${target.id}`, { method: 'DELETE' }));
		open = false;
		await invalidateAll();
	}
</script>

<Modal
	bind:open
	title="Set up {target?.name ?? ''}"
	description="Register an OAuth app once; everyone on this Corpus can then connect their own account."
>
	{#snippet icon()}<KeyRound class="size-5" />{/snippet}
	{#if target}
		<ol class="mb-4 list-decimal space-y-1.5 pl-4 text-xs text-muted">
			<li>
				{#if target.app.setupUrl}
					<a
						class="inline-flex items-center gap-1 font-medium text-primary-600 hover:underline"
						href={target.app.setupUrl}
						target="_blank"
						rel="noreferrer">Register an app with {target.name} <ExternalLink class="size-3" /></a
					>.
				{:else}
					Register an app with {target.name}.
				{/if}
				{HINTS[target.id] ?? ''}
			</li>
			<li>Paste its client ID and secret below.</li>
		</ol>

		<p class="label">Callback URL</p>
		<div class="mb-4 flex gap-2">
			<input class="input font-mono text-xs" readonly value={target.app.redirectUri} />
			<button type="button" class="btn-outline shrink-0" onclick={copy} aria-label="Copy"
				><Copy class="size-4" /></button
			>
		</div>

		{#if target.app.source === 'env'}
			<p class="rounded-lg bg-canvas px-3 py-2 text-xs text-muted">
				Configured from <code>{target.app.envPrefix}_CLIENT_ID</code> /
				<code>_CLIENT_SECRET</code> in <code>.env</code>, which takes precedence. Remove those to
				manage it here.
			</p>
		{:else}
			<form id="app-setup" class="space-y-3" onsubmit={save}>
				<label class="block">
					<span class="label">Client ID</span>
					<input class="input" bind:value={clientId} required autocomplete="off" />
				</label>
				<label class="block">
					<span class="label">Client secret</span>
					<input
						class="input"
						type="password"
						bind:value={clientSecret}
						required
						autocomplete="new-password"
						placeholder={target.app.source === 'db' ? 'Enter to replace the saved secret' : ''}
					/>
				</label>
				<p class="text-xs text-muted">The secret is encrypted before it's stored.</p>
			</form>
		{/if}
	{/if}
	{#snippet footer()}
		{#if target?.app.source === 'db'}
			<button class="btn-ghost text-red-600 hover:text-red-700" onclick={remove}>Remove</button>
		{/if}
		<button class="ml-auto btn-outline" onclick={() => (open = false)}>Cancel</button>
		{#if target?.app.source !== 'env'}
			<button class="btn-primary" form="app-setup" disabled={saving}>Save</button>
		{/if}
	{/snippet}
</Modal>
