<script lang="ts">
	import { onMount } from 'svelte';
	import { LoaderCircle, Lock, X } from '@lucide/svelte';
	import { api } from '#lib/api.js';
	import { attempt, toast } from '#lib/stores/toast.svelte.js';

	interface GoogleCalendar {
		id: string;
		name: string;
		color: string;
		primary: boolean;
		readOnly: boolean;
		selected: boolean;
	}

	let {
		connectionId,
		shareWith = null,
		ical = false
	}: {
		connectionId: string;
		/** Service account email: its calendars must be shared with it and added by ID. */
		shareWith?: string | null;
		/** Secret iCal addresses: each row is one feed, added by URL and removed individually. */
		ical?: boolean;
	} = $props();

	let list = $state<GoogleCalendar[] | null>(null);
	let failed = $state<string | null>(null);
	let saving = $state(false);
	let newId = $state('');

	async function load() {
		try {
			list = await api<GoogleCalendar[]>(`/api/integrations/${connectionId}/calendars`);
		} catch (e) {
			failed = (e as Error).message;
		}
	}

	onMount(load);

	async function add(e: SubmitEvent) {
		e.preventDefault();
		const calendarId = newId.trim();
		if (!calendarId) return;
		saving = true;
		const ok = await attempt(
			() =>
				(ical
					? api('/api/integrations/ical', { body: { url: calendarId } })
					: api(`/api/integrations/${connectionId}/calendars`, { body: { calendarId } })
				).then(() => true),
			'Could not add calendar'
		);
		saving = false;
		if (!ok) return;
		newId = '';
		toast('Calendar added', { body: 'Events appear in My Calendar shortly.' });
		await load();
	}

	async function remove(cal: GoogleCalendar) {
		if (!confirm(`Stop syncing “${cal.name}”? Its events are removed from Corpus.`)) return;
		saving = true;
		const ok = await attempt(
			() =>
				api(`/api/integrations/${connectionId}/calendars`, {
					method: 'DELETE',
					body: { calendarId: cal.id }
				}).then(() => true),
			'Could not remove calendar'
		);
		saving = false;
		if (ok) await load();
	}

	async function toggle(cal: GoogleCalendar) {
		if (!list) return;
		cal.selected = !cal.selected;
		saving = true;
		const ok = await attempt(
			() =>
				api(`/api/integrations/${connectionId}`, {
					method: 'PATCH',
					body: { calendars: list!.filter((c) => c.selected).map((c) => c.id) }
				}).then(() => true),
			'Could not update calendars'
		);
		saving = false;
		if (!ok) cal.selected = !cal.selected;
		else if (cal.selected)
			toast(`Syncing “${cal.name}”`, { body: 'Events appear in My Calendar shortly.' });
	}
</script>

<div class="space-y-1.5">
	<p class="flex items-center gap-2 font-medium">
		Calendars to sync {#if saving}<LoaderCircle class="size-3 animate-spin text-muted" />{/if}
	</p>
	{#if failed}
		<p class="text-red-600">{failed}</p>
	{:else if !list}
		<p class="flex items-center gap-2 text-muted">
			<LoaderCircle class="size-3 animate-spin" /> Loading…
		</p>
	{:else}
		<ul class="max-h-44 scrollbar-thin space-y-1 overflow-y-auto">
			{#each list as cal (cal.id)}
				<li>
					{#if ical}
						<div class="flex items-center gap-2 rounded-md px-1 py-0.5">
							<span class="size-2.5 shrink-0 rounded-full" style:background={cal.color}></span>
							<span class="min-w-0 flex-1 truncate">{cal.name}</span>
							<span title="Read-only"><Lock class="size-3 text-muted" /></span>
							{#if list.length > 1}
								<button
									class="btn-icon size-5"
									aria-label="Remove {cal.name}"
									title="Remove"
									disabled={saving}
									onclick={() => remove(cal)}><X class="size-3" /></button
								>
							{/if}
						</div>
					{:else}
						<label
							class="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 hover:bg-surface"
						>
							<input
								type="checkbox"
								class="accent-primary-500"
								checked={cal.selected}
								disabled={saving}
								onchange={() => toggle(cal)}
							/>
							<span class="size-2.5 shrink-0 rounded-full" style:background={cal.color}></span>
							<span class="min-w-0 flex-1 truncate">{cal.name}</span>
							{#if cal.primary}<span class="text-muted">Primary</span>{/if}
							{#if cal.readOnly}<span title="Read-only"><Lock class="size-3 text-muted" /></span
								>{/if}
						</label>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
	{#if ical && !failed}
		<p class="text-muted">Read-only · refreshed every 5–15 minutes.</p>
		<form class="flex gap-1.5" onsubmit={add}>
			<input
				class="input h-7 min-w-0 flex-1 font-mono text-[11px]"
				type="url"
				placeholder="Another iCal address (secret or public)"
				autocomplete="off"
				bind:value={newId}
				disabled={saving}
			/>
			<button class="btn-outline h-7 text-xs" disabled={saving || !newId.trim()}>Add</button>
		</form>
	{:else if shareWith && !failed}
		<p class="text-muted">
			Share a calendar with <span class="font-medium break-all text-ink">{shareWith}</span>, then
			add its ID (Google Calendar → Settings → Integrate calendar).
		</p>
		<form class="flex gap-1.5" onsubmit={add}>
			<input
				class="input h-7 min-w-0 flex-1 text-xs"
				placeholder="Calendar ID (e.g. team@group.calendar.google.com)"
				bind:value={newId}
				disabled={saving}
			/>
			<button class="btn-outline h-7 text-xs" disabled={saving || !newId.trim()}>Add</button>
		</form>
	{/if}
</div>
