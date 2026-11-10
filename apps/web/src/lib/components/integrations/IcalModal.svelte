<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { Link } from '@lucide/svelte';
	import Modal from '#lib/components/ui/Modal.svelte';
	import { api } from '#lib/api.js';
	import { attempt, toast } from '#lib/stores/toast.svelte.js';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	let url = $state('');
	let saving = $state(false);

	$effect(() => {
		if (open) url = '';
	});

	async function connect(e: SubmitEvent) {
		e.preventDefault();
		saving = true;
		const ok = await attempt(
			() => api('/api/integrations/ical', { body: { url: url.trim() } }).then(() => true),
			'Could not add calendar'
		);
		saving = false;
		if (!ok) return;
		toast('Google Calendar connected', {
			tone: 'success',
			body: 'Read-only — events appear shortly and refresh every 5–15 minutes.'
		});
		open = false;
		await invalidateAll();
	}
</script>

<Modal
	bind:open
	title="Connect Google Calendar with an iCal address"
	description="No OAuth app needed. Read-only: events come into Corpus, edits don’t go back."
	size="md"
>
	{#snippet icon()}<Link class="size-5" />{/snippet}
	<form id="ical-connect" class="space-y-3" onsubmit={connect}>
		<p class="text-xs text-muted">
			In Google Calendar open <span class="font-medium text-ink"
				>Settings → your calendar → Integrate calendar</span
			>
			and copy <span class="font-medium text-ink">Secret address in iCal format</span> (treat it
			like a password — it’s stored encrypted), or the
			<span class="font-medium text-ink">Public address in iCal format</span> of any public calendar.
		</p>
		<label class="block">
			<span class="label">iCal address</span>
			<input
				class="input font-mono text-[11px]"
				type="url"
				bind:value={url}
				autocomplete="off"
				spellcheck="false"
				placeholder="https://calendar.google.com/calendar/ical/…/private-…/basic.ics"
			/>
		</label>
	</form>
	{#snippet footer()}
		<button class="ml-auto btn-outline" onclick={() => (open = false)}>Cancel</button>
		<button class="btn-primary" form="ical-connect" disabled={saving || !url.trim()}>Connect</button
		>
	{/snippet}
</Modal>
