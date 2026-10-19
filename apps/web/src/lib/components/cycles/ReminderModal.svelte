<script lang="ts">
	import { untrack } from 'svelte';
	import { Bell } from '@lucide/svelte';
	import Modal from '../ui/Modal.svelte';
	import { api } from '#lib/api.js';
	import { attempt, toast } from '#lib/stores/toast.svelte.js';
	import { fromLocalInput, localDate, toLocalInput } from '#lib/calendar.js';

	interface Existing {
		id: string;
		title: string;
		notes: string | null;
		startsAt: Date;
		repeat: string;
	}

	let {
		open = $bindable(false),
		tz,
		editing = null,
		onsaved
	}: { open?: boolean; tz: string; editing?: Existing | null; onsaved: () => void } = $props();

	let title = $state('');
	let notes = $state('');
	let date = $state('');
	let time = $state('08:00');
	let repeat = $state('daily');
	let busy = $state(false);

	// Reset only when the dialog opens; untrack so live data refreshes
	// (new categories/members arrays) don't wipe the form mid-edit.
	$effect(() => {
		if (!open) return;
		untrack(() => {
			if (editing) {
				const l = toLocalInput(editing.startsAt, tz);
				title = editing.title;
				notes = editing.notes ?? '';
				date = l.date;
				time = l.time;
				repeat = editing.repeat === 'custom' ? 'daily' : editing.repeat;
			} else {
				title = '';
				notes = '';
				date = localDate(new Date(), tz);
				time = '08:00';
				repeat = 'daily';
			}
		});
	});

	async function save() {
		if (!title.trim()) return toast('Add a title', { tone: 'error' });
		busy = true;
		const body = {
			title: title.trim(),
			notes: notes.trim() || null,
			startsAt: fromLocalInput(date, time, tz),
			timezone: tz,
			repeat
		};
		const ok = await attempt(
			() =>
				(editing
					? api(`/api/reminders/${editing.id}`, { method: 'PATCH', body })
					: api('/api/reminders', { body })
				).then(() => true),
			'Could not save reminder'
		);
		busy = false;
		if (ok) {
			open = false;
			onsaved();
		}
	}
</script>

<Modal bind:open title={editing ? 'Edit reminder' : 'New reminder'} size="sm">
	{#snippet icon()}<Bell class="size-5" />{/snippet}
	<div class="space-y-4">
		<div>
			<label class="label" for="r-title">Remind me to</label>
			<input id="r-title" class="input" placeholder="Take pills" bind:value={title} />
		</div>
		<div class="grid grid-cols-2 gap-2">
			<div>
				<label class="label" for="r-date">{repeat === 'none' ? 'On' : 'Starting'}</label>
				<input id="r-date" type="date" class="input" bind:value={date} />
			</div>
			<div>
				<label class="label" for="r-time">At</label>
				<input id="r-time" type="time" class="input" bind:value={time} />
			</div>
		</div>
		<div>
			<label class="label" for="r-repeat">Repeat</label>
			<select id="r-repeat" class="input" bind:value={repeat}>
				<option value="none">Once</option>
				<option value="daily">Every day</option>
				<option value="weekdays">Every weekday</option>
				<option value="weekly">Every week</option>
				<option value="monthly">Every month</option>
			</select>
		</div>
		<div>
			<label class="label" for="r-notes">Notes</label>
			<textarea id="r-notes" class="input" rows="2" bind:value={notes}></textarea>
		</div>
	</div>
	{#snippet footer()}
		<div class="ml-auto flex gap-2">
			<button class="btn-outline-primary" onclick={() => (open = false)}>Cancel</button>
			<button class="btn-primary" disabled={busy} onclick={save}>Save</button>
		</div>
	{/snippet}
</Modal>
