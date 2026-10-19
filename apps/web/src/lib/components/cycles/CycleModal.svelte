<script lang="ts">
	import { untrack } from 'svelte';
	import { Pill, Plus, X } from '@lucide/svelte';
	import { describeCycle } from '@corpus/core';
	import Modal from '../ui/Modal.svelte';
	import { api } from '#lib/api.js';
	import { attempt, toast } from '#lib/stores/toast.svelte.js';

	interface Existing {
		id: string;
		name: string;
		kind: string;
		doseLabel: string | null;
		startDate: string;
		onDays: number;
		offDays: number;
		repeatCount: number | null;
		doseTimes: string[];
		color: string;
		notes: string | null;
	}

	let {
		open = $bindable(false),
		tz,
		today,
		editing = null,
		onsaved
	}: {
		open?: boolean;
		tz: string;
		today: string;
		editing?: Existing | null;
		onsaved: () => void;
	} = $props();

	const COLORS = ['#8E4EC6', '#2C87F2', '#30A46C', '#E5484D', '#F5A524', '#0EA5A4', '#E93D82'];

	let name = $state('');
	let kind = $state('medication');
	let doseLabel = $state('');
	let startDate = $state('');
	let onN = $state(6);
	let offN = $state(3);
	let unit = $state<'weeks' | 'days'>('weeks');
	let repeatCount = $state<number | null>(null);
	let doseTimes = $state<string[]>(['08:00']);
	let color = $state(COLORS[0]!);
	let notes = $state('');
	let busy = $state(false);

	// Reset only when the dialog opens; untrack so live data refreshes
	// (new categories/members arrays) don't wipe the form mid-edit.
	$effect(() => {
		if (!open) return;
		untrack(() => {
			if (editing) {
				name = editing.name;
				kind = editing.kind;
				doseLabel = editing.doseLabel ?? '';
				startDate = editing.startDate;
				const weeks = editing.onDays % 7 === 0 && editing.offDays % 7 === 0;
				unit = weeks ? 'weeks' : 'days';
				onN = weeks ? editing.onDays / 7 : editing.onDays;
				offN = weeks ? editing.offDays / 7 : editing.offDays;
				repeatCount = editing.repeatCount;
				doseTimes = [...editing.doseTimes];
				color = editing.color;
				notes = editing.notes ?? '';
			} else {
				name = '';
				kind = 'medication';
				doseLabel = '';
				startDate = today;
				onN = 6;
				offN = 3;
				unit = 'weeks';
				repeatCount = null;
				doseTimes = ['08:00'];
				color = COLORS[0]!;
				notes = '';
			}
		});
	});

	const mult = $derived(unit === 'weeks' ? 7 : 1);
	const preview = $derived(describeCycle({ onDays: onN * mult, offDays: offN * mult }));

	async function save() {
		if (!name.trim()) return toast('Name your cycle', { tone: 'error' });
		busy = true;
		const body = {
			name: name.trim(),
			kind,
			doseLabel: doseLabel.trim() || null,
			startDate,
			onDays: onN * mult,
			offDays: offN * mult,
			repeatCount: repeatCount || null,
			doseTimes: [...new Set(doseTimes.filter(Boolean))].sort(),
			timezone: tz,
			color,
			notes: notes.trim() || null
		};
		const ok = await attempt(
			() =>
				(editing
					? api(`/api/cycles/${editing.id}`, { method: 'PATCH', body })
					: api('/api/cycles', { body })
				).then(() => true),
			'Could not save cycle'
		);
		busy = false;
		if (ok) {
			open = false;
			toast(editing ? 'Cycle updated' : 'Cycle created', { tone: 'success', body: preview });
			onsaved();
		}
	}
</script>

<Modal
	bind:open
	title={editing ? 'Edit cycle' : 'New cycle'}
	description="Doses are only scheduled during “on” periods"
>
	{#snippet icon()}<Pill class="size-5" />{/snippet}
	<div class="space-y-4">
		<div class="grid grid-cols-[1fr_auto] gap-2">
			<div>
				<label class="label" for="c-name">Name</label>
				<input id="c-name" class="input" placeholder="e.g. Isotretinoin" bind:value={name} />
			</div>
			<div>
				<label class="label" for="c-kind">Type</label>
				<select id="c-kind" class="input" bind:value={kind}>
					<option value="medication">Medication</option>
					<option value="supplement">Supplement</option>
					<option value="training">Training</option>
					<option value="other">Other</option>
				</select>
			</div>
		</div>

		<div>
			<p class="label">Schedule</p>
			<div class="flex flex-wrap items-center gap-2 text-sm">
				<input type="number" min="1" class="input w-20" bind:value={onN} aria-label="On length" />
				<span>on,</span>
				<input type="number" min="0" class="input w-20" bind:value={offN} aria-label="Off length" />
				<span>off, in</span>
				<select class="input w-28" bind:value={unit}>
					<option value="weeks">weeks</option>
					<option value="days">days</option>
				</select>
			</div>
			<p class="mt-1.5 text-xs text-muted">{preview}</p>
		</div>

		<div class="grid gap-2 sm:grid-cols-2">
			<div>
				<label class="label" for="c-start">First day</label>
				<input id="c-start" type="date" class="input" bind:value={startDate} />
			</div>
			<div>
				<label class="label" for="c-repeat">Number of cycles</label>
				<input
					id="c-repeat"
					type="number"
					min="1"
					class="input"
					placeholder="Repeat forever"
					bind:value={repeatCount}
				/>
			</div>
		</div>

		<div>
			<p class="label">Dose times</p>
			<div class="flex flex-wrap items-center gap-2">
				{#each doseTimes as _, i (i)}
					<span class="flex input w-auto items-center gap-1 pr-1.5">
						<input type="time" class="bg-transparent outline-none" bind:value={doseTimes[i]} />
						<button
							type="button"
							class="text-muted hover:text-ink"
							aria-label="Remove time"
							onclick={() => (doseTimes = doseTimes.filter((_, j) => j !== i))}
							><X class="size-3.5" /></button
						>
					</span>
				{/each}
				<button
					type="button"
					class="btn-ghost h-10"
					onclick={() => (doseTimes = [...doseTimes, '20:00'])}
					><Plus class="size-4" /> Add time</button
				>
			</div>
		</div>

		<div class="grid gap-2 sm:grid-cols-[1fr_auto]">
			<div>
				<label class="label" for="c-dose">Dose</label>
				<input
					id="c-dose"
					class="input"
					placeholder="e.g. 1 tablet · 20mg"
					bind:value={doseLabel}
				/>
			</div>
			<div>
				<p class="label">Color</p>
				<div class="flex h-10 items-center gap-1.5">
					{#each COLORS as c (c)}
						<button
							type="button"
							aria-label="Color {c}"
							class="size-6 rounded-full ring-offset-2 {color === c ? 'ring-2' : ''}"
							style:background={c}
							style:--tw-ring-color={c}
							onclick={() => (color = c)}
						></button>
					{/each}
				</div>
			</div>
		</div>

		<div>
			<label class="label" for="c-notes">Notes</label>
			<textarea
				id="c-notes"
				class="input"
				rows="2"
				placeholder="Prescriber, instructions…"
				bind:value={notes}></textarea>
		</div>
	</div>
	{#snippet footer()}
		<div class="ml-auto flex gap-2">
			<button class="btn-outline-primary" onclick={() => (open = false)}>Cancel</button>
			<button class="btn-primary" disabled={busy} onclick={save}
				>{busy ? 'Saving…' : 'Save cycle'}</button
			>
		</div>
	{/snippet}
</Modal>
