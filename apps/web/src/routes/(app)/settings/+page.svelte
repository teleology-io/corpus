<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { refreshAll } from '$app/navigation';
	import { BellRing, Plus, Trash2 } from '@lucide/svelte';
	import Switch from '#lib/components/ui/Switch.svelte';
	import Icon, { ICONS } from '#lib/components/ui/Icon.svelte';
	import Avatar from '#lib/components/ui/Avatar.svelte';
	import { api } from '#lib/api.js';
	import { attempt, toast } from '#lib/stores/toast.svelte.js';
	import { currentSubscription, disablePush, enablePush, pushSupported } from '#lib/push.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let name = $state('');
	let timezone = $state('');
	let weekStartsOn = $state(0);
	let types = $state<typeof data.prefs.types>([]);
	let quietOn = $state(false);
	let quietStart = $state('22:00');
	let quietEnd = $state('07:00');
	let dailyDigest = $state(false);
	let pushOn = $state(false);
	let pushAvailable = $state(false);
	let newCat = $state({ name: '', color: '#2C87F2', icon: 'calendar' });

	// Seed the form once; live refreshes (refreshAll on notifications) must not wipe edits.
	untrack(() => {
		name = data.user.name;
		timezone = data.user.timezone;
		weekStartsOn = data.user.weekStartsOn;
		types = data.prefs.types.map((t) => ({ ...t }));
		quietOn = !!data.prefs.quietStart;
		quietStart = data.prefs.quietStart ?? '22:00';
		quietEnd = data.prefs.quietEnd ?? '07:00';
		dailyDigest = data.prefs.dailyDigest;
	});

	onMount(async () => {
		pushAvailable = pushSupported() && !!data.config.vapidKey;
		if (pushAvailable) pushOn = !!(await currentSubscription());
	});

	async function saveProfile(e: SubmitEvent) {
		e.preventDefault();
		const ok = await attempt(() =>
			api('/api/me', { method: 'PATCH', body: { name, timezone, weekStartsOn } }).then(() => true)
		);
		if (ok) {
			toast('Profile saved', { tone: 'success' });
			await refreshAll();
		}
	}

	let prefTimer: ReturnType<typeof setTimeout>;
	function savePrefs() {
		clearTimeout(prefTimer);
		prefTimer = setTimeout(() => {
			void attempt(() =>
				api('/api/notifications/prefs', {
					method: 'PUT',
					body: {
						types,
						quietStart: quietOn ? quietStart : null,
						quietEnd: quietOn ? quietEnd : null,
						dailyDigest
					}
				})
			);
		}, 300);
	}

	async function togglePush(on: boolean) {
		const ok = await attempt(async () => {
			if (on) await enablePush(data.config.vapidKey!);
			else await disablePush();
			return true;
		}, 'Push notifications');
		pushOn = ok ? on : !on;
		if (ok && on) toast('Push enabled on this device', { tone: 'success' });
	}

	async function addCategory(e: SubmitEvent) {
		e.preventDefault();
		if (!newCat.name.trim()) return;
		await attempt(() => api('/api/categories', { body: newCat }));
		newCat = { name: '', color: '#2C87F2', icon: 'calendar' };
		await refreshAll();
	}

	async function updateCategory(id: string, patch: Record<string, string>) {
		await attempt(() => api(`/api/categories/${id}`, { method: 'PATCH', body: patch }));
		await refreshAll();
	}

	async function removeCategory(id: string) {
		await attempt(() => api(`/api/categories/${id}`, { method: 'DELETE' }));
		await refreshAll();
	}

	const groups = $derived([...new Set(types.map((t) => t.group))]);
</script>

<svelte:head><title>Settings · Corpus</title></svelte:head>

<div class="mx-auto max-w-4xl space-y-6 p-4 lg:p-8">
	<section class="card p-5">
		<h2 class="font-semibold">Profile</h2>
		<form class="mt-4 grid gap-4 sm:grid-cols-[auto_1fr]" onsubmit={saveProfile}>
			<Avatar name={data.user.name} image={data.user.image} size={64} />
			<div class="grid gap-3 sm:grid-cols-2">
				<div>
					<label class="label" for="s-name">Name</label>
					<input id="s-name" class="input" bind:value={name} required />
				</div>
				<div>
					<label class="label" for="s-email">Email</label>
					<input id="s-email" class="input bg-canvas" value={data.user.email} disabled />
				</div>
				<div>
					<label class="label" for="s-tz">Time zone</label>
					<select id="s-tz" class="input" bind:value={timezone}>
						{#each data.timezones as tz (tz)}<option value={tz}>{tz.replace(/_/g, ' ')}</option
							>{/each}
					</select>
				</div>
				<div>
					<label class="label" for="s-week">Week starts on</label>
					<select id="s-week" class="input" bind:value={weekStartsOn}>
						<option value={0}>Sunday</option>
						<option value={1}>Monday</option>
						<option value={6}>Saturday</option>
					</select>
				</div>
				<div class="sm:col-span-2"><button class="btn-primary">Save profile</button></div>
			</div>
		</form>
	</section>

	<section class="card p-5" id="notifications">
		<div class="flex flex-wrap items-start gap-3">
			<div class="flex-1">
				<h2 class="font-semibold">Notifications</h2>
				<p class="text-sm text-muted">Choose how you hear about each kind of event.</p>
			</div>
			<div class="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
				<BellRing class="size-4 text-primary-500" />
				<span class="text-sm">Push on this device</span>
				<Switch
					checked={pushOn}
					disabled={!pushAvailable}
					label="Push on this device"
					onchange={togglePush}
				/>
			</div>
		</div>
		{#if !pushAvailable}
			<p class="mt-2 text-xs text-muted">
				{data.config.vapidKey
					? 'This browser does not support web push.'
					: 'Web push is not configured on the server (VAPID keys).'}
			</p>
		{/if}

		<div class="mt-5 overflow-x-auto">
			<table class="w-full min-w-[520px] text-sm">
				<thead>
					<tr class="text-left text-xs text-muted">
						<th class="pb-2 font-medium">Type</th>
						<th class="w-20 pb-2 text-center font-medium">In-app</th>
						<th class="w-20 pb-2 text-center font-medium">Push</th>
						<th class="w-20 pb-2 text-center font-medium">Email</th>
					</tr>
				</thead>
				{#each groups as g (g)}
					<tbody>
						<tr
							><td
								colspan="4"
								class="pt-4 pb-1 text-[11px] font-semibold tracking-wide text-gray-400 uppercase"
								>{g}</td
							></tr
						>
						{#each types.filter((t) => t.group === g) as t (t.type)}
							<tr class="border-t border-line/70">
								<td class="py-2.5 pr-3">
									<p class="font-medium">{t.label}</p>
									<p class="text-xs text-muted">{t.description}</p>
								</td>
								<td class="text-center"
									><input
										type="checkbox"
										class="size-4 accent-primary-500"
										bind:checked={t.inApp}
										onchange={savePrefs}
										aria-label="{t.label} in-app"
									/></td
								>
								<td class="text-center"
									><input
										type="checkbox"
										class="size-4 accent-primary-500"
										bind:checked={t.push}
										onchange={savePrefs}
										aria-label="{t.label} push"
									/></td
								>
								<td class="text-center"
									><input
										type="checkbox"
										class="size-4 accent-primary-500"
										bind:checked={t.email}
										onchange={savePrefs}
										aria-label="{t.label} email"
									/></td
								>
							</tr>
						{/each}
					</tbody>
				{/each}
			</table>
		</div>

		<div class="mt-6 grid gap-4 border-t border-line pt-5 sm:grid-cols-2">
			<div>
				<label class="flex items-center justify-between text-sm font-medium"
					>Quiet hours <Switch
						bind:checked={quietOn}
						onchange={savePrefs}
						label="Quiet hours"
					/></label
				>
				<p class="text-xs text-muted">No push notifications during this window.</p>
				{#if quietOn}
					<div class="mt-2 flex items-center gap-2">
						<input type="time" class="input" bind:value={quietStart} onchange={savePrefs} />
						<span class="text-muted">to</span>
						<input type="time" class="input" bind:value={quietEnd} onchange={savePrefs} />
					</div>
				{/if}
			</div>
			<div>
				<label class="flex items-center justify-between text-sm font-medium"
					>Daily digest <Switch
						bind:checked={dailyDigest}
						onchange={savePrefs}
						label="Daily digest"
					/></label
				>
				<p class="text-xs text-muted">A 7am summary of your day's appointments and tasks.</p>
			</div>
		</div>
	</section>

	<section class="card p-5">
		<h2 class="font-semibold">Schedule categories</h2>
		<p class="text-sm text-muted">
			The “Mark Schedule” options when creating events in this workspace.
		</p>
		<ul class="mt-4 divide-y divide-line">
			{#each data.categories as c (c.id)}
				<li class="flex items-center gap-3 py-2.5">
					<input
						type="color"
						value={c.color}
						class="size-7 cursor-pointer rounded border-0 bg-transparent p-0"
						aria-label="Color"
						onchange={(e) => updateCategory(c.id, { color: e.currentTarget.value })}
					/>
					<span style:color={c.color}><Icon name={c.icon} /></span>
					<input
						class="input h-8 flex-1"
						value={c.name}
						onchange={(e) => updateCategory(c.id, { name: e.currentTarget.value })}
					/>
					<select
						class="input h-8 w-36 text-xs"
						value={c.icon}
						onchange={(e) => updateCategory(c.id, { icon: e.currentTarget.value })}
					>
						{#each Object.keys(ICONS) as i (i)}<option value={i}>{i}</option>{/each}
					</select>
					<button
						class="btn-icon size-8 hover:text-red-600"
						aria-label="Delete category"
						onclick={() => removeCategory(c.id)}><Trash2 class="size-4" /></button
					>
				</li>
			{/each}
		</ul>
		<form class="mt-3 flex items-center gap-2" onsubmit={addCategory}>
			<input
				type="color"
				bind:value={newCat.color}
				class="size-7 cursor-pointer rounded border-0 bg-transparent p-0"
				aria-label="New color"
			/>
			<input class="input h-9 flex-1" placeholder="New category" bind:value={newCat.name} />
			<select class="input h-9 w-36 text-xs" bind:value={newCat.icon}>
				{#each Object.keys(ICONS) as i (i)}<option value={i}>{i}</option>{/each}
			</select>
			<button class="btn-outline h-9"><Plus class="size-4" /> Add</button>
		</form>
	</section>
</div>
