<script lang="ts">
	import { untrack } from 'svelte';
	import { DropdownMenu } from 'bits-ui';
	import {
		CalendarPlus,
		CalendarDays,
		ChevronDown,
		Clock,
		Trash2,
		X,
		UserPlus,
		ExternalLink,
		Video,
		Lock,
		MapPin,
		Repeat,
		Bell
	} from '@lucide/svelte';
	import { rulePreset, ruleUntil } from '@corpus/core';
	import BrandIcon from '../ui/BrandIcon.svelte';
	import Modal from '../ui/Modal.svelte';
	import Icon from '../ui/Icon.svelte';
	import Avatar from '../ui/Avatar.svelte';
	import Switch from '../ui/Switch.svelte';
	import { api } from '#lib/api.js';
	import { attempt, toast } from '#lib/stores/toast.svelte.js';
	import {
		addDaysToDate,
		atLocal,
		fromLocalInput,
		toLocalInput,
		localDate
	} from '#lib/calendar.js';
	import type { CalendarDTO, CategoryDTO, EditScope, OccurrenceDTO } from '#lib/types.js';

	interface Member {
		id: string;
		name: string;
		email: string;
		image: string | null;
	}

	let {
		open = $bindable(false),
		tz,
		categories,
		calendars = [],
		members,
		me,
		editing = null,
		initial = null,
		onsaved
	}: {
		open?: boolean;
		tz: string;
		categories: CategoryDTO[];
		calendars?: CalendarDTO[];
		members: Member[];
		me: string;
		editing?: OccurrenceDTO | null;
		initial?: { start: string; end: string; allDay?: boolean } | null;
		onsaved: () => void;
	} = $props();

	const REMINDER_OPTIONS = [
		{ v: 0, label: 'At time' },
		{ v: 5, label: '5 min' },
		{ v: 10, label: '10 min' },
		{ v: 30, label: '30 min' },
		{ v: 60, label: '1 hour' },
		{ v: 1440, label: '1 day' }
	];
	const REPEATS = [
		['none', 'Does not repeat'],
		['daily', 'Every day'],
		['weekdays', 'Every weekday'],
		['weekly', 'Every week'],
		['biweekly', 'Every 2 weeks'],
		['monthly', 'Every month'],
		['yearly', 'Every year']
	] as const;

	let step = $state(1);
	let busy = $state(false);
	let categoryId = $state<string | null>(null);
	let color = $state('#2C87F2');
	let opacity = $state(100);
	let title = $state('');
	let date = $state('');
	let endDate = $state('');
	let startTime = $state('09:00');
	let endTime = $state('10:00');
	let allDay = $state(false);
	let repeat = $state<string>('none');
	let customRule = $state<string | null>(null);
	let until = $state('');
	let reminders = $state<number[]>([10]);
	let attendees = $state<
		{ userId?: string | null; email?: string | null; name: string; image?: string | null }[]
	>([]);
	let inviteEmail = $state('');
	let location = $state('');
	let description = $state('');
	let scope = $state<EditScope>('this');
	let calendarId = $state<string | null>(null);

	const writable = $derived(calendars.filter((c) => !c.readOnly));
	const readOnly = $derived(!!editing && !editing.canEdit);

	// Reset form whenever the modal opens.
	// Reset only when the dialog opens; untrack so live data refreshes
	// (new categories/members arrays) don't wipe the form mid-edit.
	$effect(() => {
		if (!open) return;
		untrack(() => {
			step = 1;
			scope = 'this';
			inviteEmail = '';
			calendarId = editing
				? editing.calendarId
				: ((writable.find((c) => c.isDefault && !c.provider) ?? writable[0])?.id ?? null);
			if (editing) {
				const s = toLocalInput(editing.start, tz);
				const e = toLocalInput(editing.end, tz);
				categoryId = editing.category?.id ?? null;
				color = editing.color;
				opacity = editing.opacity;
				title = editing.title;
				allDay = editing.allDay;
				date = s.date;
				startTime = s.time;
				endTime = e.time;
				endDate = editing.allDay ? addDaysToDate(e.date, -1) : e.date;
				const preset = rulePreset(editing.rrule);
				repeat = preset;
				customRule = preset === 'custom' ? editing.rrule : null;
				// UNTIL is a UTC instant; show the local date it falls on.
				const u = ruleUntil(editing.rrule);
				until = u ? localDate(u, tz) : '';
				reminders = [...editing.reminders];
				attendees = editing.attendees.map((a) => ({
					userId: a.id,
					email: a.email,
					name: a.name,
					image: a.image
				}));
				location = editing.location ?? '';
				description = editing.description ?? '';
			} else {
				const start =
					initial?.start ?? atLocal(localDate(new Date(), tz), '09:00', tz).toISOString();
				const end = initial?.end ?? new Date(new Date(start).getTime() + 3_600_000).toISOString();
				const s = toLocalInput(start, tz);
				const e = toLocalInput(end, tz);
				const cat = categories[0] ?? null;
				categoryId = cat?.id ?? null;
				color = cat?.color ?? '#2C87F2';
				opacity = 100;
				title = '';
				allDay = initial?.allDay ?? false;
				date = s.date;
				endDate = allDay ? s.date : e.date;
				startTime = s.time;
				endTime = e.time;
				repeat = 'none';
				customRule = null;
				until = '';
				reminders = [10];
				attendees = [];
				location = '';
				description = '';
			}
		});
	});

	const category = $derived(categories.find((c) => c.id === categoryId) ?? null);

	// ----- read-only details view (synced calendars you can't edit) -----
	const URL_RE = /(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]])/g;
	/** Plain text split into text / link parts, so links are clickable without {@html}. */
	const linkify = (text: string) =>
		text.split(URL_RE).map((part, i) => ({ text: part, href: i % 2 ? part : null }));
	const RSVP_LABEL: Record<string, string> = {
		accepted: 'Going',
		declined: 'Declined',
		tentative: 'Maybe',
		pending: 'Awaiting'
	};
	const calendarName = $derived(
		editing ? (calendars.find((c) => c.id === editing.calendarId)?.name ?? null) : null
	);
	const when = $derived.by(() => {
		if (!editing) return '';
		const start = new Date(editing.start);
		const end = new Date(editing.end);
		const day = (d: Date) =>
			new Intl.DateTimeFormat(undefined, {
				weekday: 'short',
				month: 'short',
				day: 'numeric',
				year: 'numeric',
				timeZone: tz
			}).format(d);
		if (editing.allDay) {
			// All-day ends are exclusive midnights.
			const last = new Date(end.getTime() - 1);
			return day(start) === day(last) ? day(start) : `${day(start)} – ${day(last)}`;
		}
		const time = (d: Date) =>
			new Intl.DateTimeFormat(undefined, {
				hour: 'numeric',
				minute: '2-digit',
				timeZone: tz
			}).format(d);
		return day(start) === day(end)
			? `${day(start)} · ${time(start)} – ${time(end)}`
			: `${day(start)} ${time(start)} – ${day(end)} ${time(end)}`;
	});
	const repeatLabel = $derived.by(() => {
		if (!editing?.rrule) return null;
		const preset = rulePreset(editing.rrule);
		return preset === 'custom' || preset === 'none' ? 'Repeats' : `Repeats ${preset}`;
	});

	function pickCategory(c: CategoryDTO) {
		categoryId = c.id;
		color = c.color;
	}

	function toggleReminder(v: number) {
		reminders = reminders.includes(v)
			? reminders.filter((r) => r !== v)
			: [...reminders, v].sort((a, b) => a - b);
	}

	function addMember(m: Member) {
		if (!attendees.some((a) => a.userId === m.id))
			attendees = [...attendees, { userId: m.id, email: m.email, name: m.name, image: m.image }];
	}

	function addEmail() {
		const email = inviteEmail.trim().toLowerCase();
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
			return toast('Enter a valid email', { tone: 'error' });
		const m = members.find((x) => x.email.toLowerCase() === email);
		if (m) addMember(m);
		else if (!attendees.some((a) => a.email === email))
			attendees = [...attendees, { email, name: email }];
		inviteEmail = '';
	}

	function payload() {
		const start = allDay
			? atLocal(date, '00:00', tz).toISOString()
			: fromLocalInput(date, startTime, tz);
		let end = allDay
			? atLocal(addDaysToDate(endDate < date ? date : endDate, 1), '00:00', tz).toISOString()
			: fromLocalInput(endDate || date, endTime, tz);
		if (!allDay && new Date(end) <= new Date(start)) {
			// End before start on the same day means it runs past midnight.
			end = new Date(new Date(end).getTime() + 86_400_000).toISOString();
		}
		return {
			title: title.trim(),
			...(!editing && calendarId && { calendarId }),
			categoryId,
			color,
			opacity,
			start,
			end,
			allDay,
			timezone: tz,
			repeat,
			rrule: repeat === 'custom' ? customRule : null,
			until: until ? atLocal(until, '23:59', tz).toISOString() : null,
			reminders,
			attendees: attendees.map((a) => ({
				userId: a.userId ?? null,
				email: a.email ?? null,
				name: a.name
			})),
			location: location.trim() || null,
			description: description.trim() || null
		};
	}

	async function save() {
		if (!title.trim()) {
			step = 1;
			return toast('Add a title', { tone: 'error' });
		}
		busy = true;
		const body = payload();
		const ok = await attempt(async () => {
			if (editing) {
				await api(`/api/events/${editing.eventId}`, {
					method: 'PATCH',
					body: {
						...body,
						scope: editing.recurring ? scope : 'all',
						originalStart: editing.originalStart
					}
				});
			} else {
				await api('/api/events', { body });
			}
			return true;
		}, 'Could not save schedule');
		busy = false;
		if (ok) {
			open = false;
			toast(editing ? 'Schedule updated' : 'Schedule created', { tone: 'success' });
			onsaved();
		}
	}

	async function remove() {
		if (!editing) return;
		const s = editing.recurring ? scope : 'all';
		const ok = await attempt(
			() =>
				api(
					`/api/events/${editing!.eventId}?scope=${s}&originalStart=${encodeURIComponent(editing!.originalStart)}`,
					{ method: 'DELETE' }
				).then(() => true),
			'Could not delete'
		);
		if (ok) {
			open = false;
			toast('Moved to Deleted Schedule', { tone: 'success' });
			onsaved();
		}
	}
</script>

<Modal
	bind:open
	title={readOnly ? 'Event details' : editing ? 'Edit Schedule' : 'Create Schedule'}
	description={readOnly
		? (calendarName ?? 'Read-only calendar')
		: step === 1
			? 'Fill in the data below to add a schedule'
			: 'Repeat, reminders and people'}
>
	{#snippet icon()}<CalendarPlus class="size-5" />{/snippet}

	{#if editing?.external}
		<div
			class="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-canvas px-3 py-2 text-xs text-muted"
		>
			<span class="flex items-center gap-1.5 font-medium text-ink"
				><BrandIcon name={editing.external.provider} class="size-3.5" /> Synced with Google Calendar</span
			>
			{#if editing.external.organizer}<span>Organized by {editing.external.organizer}</span>{/if}
			{#if readOnly}<span class="flex items-center gap-1"><Lock class="size-3" /> Read-only</span
				>{/if}
			<span class="ml-auto flex gap-3">
				{#if editing.external.meetUrl}<a
						class="flex items-center gap-1 text-primary-600 hover:underline"
						href={editing.external.meetUrl}
						target="_blank"
						rel="noreferrer"><Video class="size-3.5" /> Join</a
					>{/if}
				{#if editing.external.url}<a
						class="flex items-center gap-1 text-primary-600 hover:underline"
						href={editing.external.url}
						target="_blank"
						rel="noreferrer"><ExternalLink class="size-3.5" /> Open in Google</a
					>{/if}
			</span>
		</div>
	{/if}

	{#if readOnly && editing}
		<div class="space-y-4 text-sm">
			<div class="flex items-start gap-3">
				<span class="mt-1.5 size-3 shrink-0 rounded-full" style:background={editing.color}></span>
				<div class="min-w-0">
					<h3 class="text-base font-semibold break-words">{editing.title}</h3>
					<p class="mt-0.5 text-muted">{when}</p>
					{#if repeatLabel}<p class="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
							<Repeat class="size-3" />{repeatLabel}
						</p>{/if}
				</div>
			</div>
			{#if editing.location}
				<p class="flex items-start gap-2">
					<MapPin class="mt-0.5 size-4 shrink-0 text-muted" />
					<span class="min-w-0 break-words">
						{#each linkify(editing.location) as part, i (i)}{#if part.href}<a
									class="text-primary-600 hover:underline"
									href={part.href}
									target="_blank"
									rel="noreferrer">{part.text}</a
								>{:else}{part.text}{/if}{/each}
					</span>
				</p>
			{/if}
			{#if editing.description}
				<div
					class="max-h-72 scrollbar-thin overflow-y-auto rounded-lg bg-canvas px-3 py-2 break-words whitespace-pre-wrap"
				>
					{#each linkify(editing.description) as part, i (i)}{#if part.href}<a
								class="text-primary-600 hover:underline"
								href={part.href}
								target="_blank"
								rel="noreferrer">{part.text}</a
							>{:else}{part.text}{/if}{/each}
				</div>
			{/if}
			{#if editing.attendees.length}
				<div>
					<p class="label">Guests · {editing.attendees.length}</p>
					<ul class="max-h-48 scrollbar-thin space-y-1.5 overflow-y-auto">
						{#each editing.attendees as a, i (a.id ?? a.email ?? i)}
							<li class="flex items-center gap-2">
								<Avatar name={a.name} image={a.image} size={22} />
								<span class="min-w-0 flex-1 truncate"
									>{a.name}{#if a.email && a.email !== a.name}<span class="text-muted">
											· {a.email}</span
										>{/if}</span
								>
								{#if a.rsvp}<span
										class="shrink-0 text-xs {a.rsvp === 'accepted'
											? 'text-emerald-600'
											: a.rsvp === 'declined'
												? 'text-red-600'
												: 'text-muted'}">{RSVP_LABEL[a.rsvp] ?? a.rsvp}</span
									>{/if}
							</li>
						{/each}
					</ul>
				</div>
			{/if}
			{#if editing.reminders.length}
				<p class="flex items-center gap-2 text-xs text-muted">
					<Bell class="size-3.5" />
					{editing.reminders
						.map((m) =>
							m === 0
								? 'At start'
								: m % 1440 === 0
									? `${m / 1440}d before`
									: m % 60 === 0
										? `${m / 60}h before`
										: `${m} min before`
						)
						.join(', ')}
				</p>
			{/if}
		</div>
	{:else if step === 1}
		<div class="space-y-4">
			<div>
				<p class="label">Mark Schedule</p>
				<div class="flex gap-2">
					<DropdownMenu.Root>
						<DropdownMenu.Trigger class="flex input flex-1 items-center gap-2 text-left">
							<span style:color><Icon name={category?.icon ?? 'calendar'} /></span>
							<span class="flex-1 truncate">{category?.name ?? 'No category'}</span>
							<ChevronDown class="size-4 text-muted" />
						</DropdownMenu.Trigger>
						<DropdownMenu.Portal>
							<DropdownMenu.Content
								class="menu w-[var(--bits-dropdown-menu-anchor-width)]"
								sideOffset={4}
								align="start"
							>
								{#each categories as c (c.id)}
									<DropdownMenu.Item class="menu-item" onSelect={() => pickCategory(c)}>
										<span style:color={c.color}><Icon name={c.icon} /></span>{c.name}
									</DropdownMenu.Item>
								{/each}
							</DropdownMenu.Content>
						</DropdownMenu.Portal>
					</DropdownMenu.Root>
					<label class="flex input w-40 items-center gap-2">
						<input
							type="color"
							bind:value={color}
							class="size-5 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
							aria-label="Color"
						/>
						<input
							class="w-full min-w-0 bg-transparent text-sm uppercase outline-none"
							bind:value={color}
							maxlength="7"
							aria-label="Hex color"
						/>
					</label>
					<label class="flex input w-20 items-center gap-0.5">
						<input
							type="number"
							min="10"
							max="100"
							step="5"
							bind:value={opacity}
							class="w-full min-w-0 bg-transparent text-sm outline-none"
							aria-label="Opacity"
						/>%
					</label>
				</div>
			</div>

			<div>
				<label class="label" for="ev-title">Title Schedule</label>
				<input
					id="ev-title"
					class="input"
					placeholder="e.g. Ideation marketplace app"
					bind:value={title}
				/>
			</div>

			{#if writable.length > 1 && !editing}
				<div>
					<label class="label" for="ev-calendar">Calendar</label>
					<select id="ev-calendar" class="input" bind:value={calendarId}>
						{#each writable as c (c.id)}
							<option value={c.id}
								>{c.name}{c.provider
									? ` · Google${c.account ? ` (${c.account})` : ''}`
									: ''}</option
							>
						{/each}
					</select>
				</div>
			{/if}

			<div>
				<div class="mb-1.5 flex items-center justify-between">
					<p class="label mb-0">Date &amp; Time</p>
					<label class="flex items-center gap-2 text-xs text-muted"
						>All day <Switch bind:checked={allDay} label="All day" /></label
					>
				</div>
				<div class="space-y-2">
					<label class="flex input items-center gap-2">
						<CalendarDays class="size-4 text-muted" />
						<input
							type="date"
							class="flex-1 bg-transparent outline-none"
							bind:value={date}
							required
						/>
					</label>
					{#if allDay}
						<label class="flex input items-center gap-2">
							<span class="text-xs text-muted">Until</span>
							<input
								type="date"
								class="flex-1 bg-transparent outline-none"
								bind:value={endDate}
								min={date}
							/>
						</label>
					{:else}
						<div class="flex items-center gap-2">
							<label class="flex input flex-1 items-center gap-2">
								<Clock class="size-4 text-muted" />
								<input
									type="time"
									class="flex-1 bg-transparent outline-none"
									bind:value={startTime}
									step="300"
								/>
							</label>
							<span class="text-muted">-</span>
							<label class="flex input flex-1 items-center gap-2">
								<Clock class="size-4 text-muted" />
								<input
									type="time"
									class="flex-1 bg-transparent outline-none"
									bind:value={endTime}
									step="300"
								/>
							</label>
						</div>
					{/if}
				</div>
			</div>
		</div>
	{:else}
		<div class="space-y-4">
			<div class="grid gap-2 sm:grid-cols-[1fr_auto]">
				<div>
					<label class="label" for="ev-repeat">Repeat</label>
					<select id="ev-repeat" class="input" bind:value={repeat}>
						{#each REPEATS as [v, l] (v)}<option value={v}>{l}</option>{/each}
						{#if customRule}<option value="custom">Custom ({customRule})</option>{/if}
					</select>
				</div>
				{#if repeat !== 'none'}
					<div>
						<label class="label" for="ev-until">Ends</label>
						<input id="ev-until" type="date" class="input" bind:value={until} min={date} />
					</div>
				{/if}
			</div>

			<div>
				<p class="label">Remind me</p>
				<div class="flex flex-wrap gap-1.5">
					{#each REMINDER_OPTIONS as r (r.v)}
						<button
							type="button"
							class="chip border px-2.5 py-1 {reminders.includes(r.v)
								? 'border-primary-500 bg-primary-50 text-primary-600'
								: 'border-line text-muted hover:text-ink'}"
							onclick={() => toggleReminder(r.v)}>{r.label}</button
						>
					{/each}
				</div>
			</div>

			<div>
				<p class="label">People</p>
				<div class="flex gap-2">
					<input
						class="input flex-1"
						placeholder="Add by email"
						bind:value={inviteEmail}
						onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), addEmail())}
					/>
					<DropdownMenu.Root>
						<DropdownMenu.Trigger class="btn-outline h-10" disabled={members.length <= 1}
							><UserPlus class="size-4" /> Members</DropdownMenu.Trigger
						>
						<DropdownMenu.Portal>
							<DropdownMenu.Content
								class="menu max-h-64 w-60 overflow-y-auto"
								align="end"
								sideOffset={4}
							>
								{#each members.filter((m) => m.id !== me) as m (m.id)}
									<DropdownMenu.Item class="menu-item" onSelect={() => addMember(m)}>
										<Avatar name={m.name} image={m.image} size={22} />
										<span class="truncate">{m.name}</span>
									</DropdownMenu.Item>
								{/each}
							</DropdownMenu.Content>
						</DropdownMenu.Portal>
					</DropdownMenu.Root>
				</div>
				{#if attendees.length}
					<ul class="mt-2 flex flex-wrap gap-1.5">
						{#each attendees as a, i (a.userId ?? a.email ?? i)}
							<li class="chip bg-canvas py-1 pr-1 pl-1 text-ink">
								<Avatar name={a.name} image={a.image} size={18} />
								<span class="max-w-36 truncate">{a.name}</span>
								<button
									type="button"
									class="text-muted hover:text-ink"
									aria-label="Remove"
									onclick={() => (attendees = attendees.filter((_, j) => j !== i))}
									><X class="size-3" /></button
								>
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			<div>
				<label class="label" for="ev-loc">Location / link</label>
				<input
					id="ev-loc"
					class="input"
					placeholder="Room, address or meeting link"
					bind:value={location}
				/>
			</div>
			<div>
				<label class="label" for="ev-desc">Notes</label>
				<textarea id="ev-desc" class="input" rows="3" bind:value={description}></textarea>
			</div>
		</div>
	{/if}

	{#if editing?.recurring && !readOnly}
		<fieldset class="mt-4 rounded-lg border border-line p-3">
			<legend class="px-1 text-xs font-semibold">Apply changes to</legend>
			<div class="flex flex-wrap gap-4 text-sm">
				{#each [['this', 'This event'], ['following', 'This and following'], ['all', 'All events']] as [v, l] (v)}
					<label class="flex items-center gap-1.5"
						><input
							type="radio"
							bind:group={scope}
							value={v}
							class="accent-primary-500"
						/>{l}</label
					>
				{/each}
			</div>
		</fieldset>
	{/if}

	{#snippet footer()}
		<div class="flex items-center gap-1.5">
			<span
				class="h-1.5 rounded-full transition-all {step === 1
					? 'w-8 bg-primary-500'
					: 'w-1.5 bg-gray-300'}"
			></span>
			<span
				class="h-1.5 rounded-full transition-all {step === 2
					? 'w-8 bg-primary-500'
					: 'w-1.5 bg-gray-300'}"
			></span>
		</div>
		{#if editing?.canEdit}
			<button
				class="ml-2 btn-ghost text-red-600 hover:bg-red-50 hover:text-red-700"
				onclick={remove}><Trash2 class="size-4" /> Delete</button
			>
		{/if}
		<div class="ml-auto flex gap-2">
			{#if readOnly}
				<button class="btn-outline-primary w-24" onclick={() => (open = false)}>Close</button>
			{:else if step === 1}
				<button class="btn-outline-primary w-24" onclick={() => (open = false)}>Cancel</button>
				{#if editing}<button class="btn-outline" onclick={() => (step = 2)}>More</button>{/if}
				<button
					class="btn-primary w-24"
					disabled={busy}
					onclick={() => (editing ? save() : (step = 2))}>{editing ? 'Save' : 'Continue'}</button
				>
			{:else}
				<button class="btn-outline-primary w-24" onclick={() => (step = 1)}>Back</button>
				<button class="btn-primary w-24" disabled={busy} onclick={save}
					>{busy ? 'Saving…' : 'Save'}</button
				>
			{/if}
		</div>
	{/snippet}
</Modal>
