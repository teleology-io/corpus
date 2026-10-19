<script lang="ts">
	import { onMount } from 'svelte';
	import { LoaderCircle, Lock } from '@lucide/svelte';
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

	let { connectionId }: { connectionId: string } = $props();

	let list = $state<GoogleCalendar[] | null>(null);
	let failed = $state<string | null>(null);
	let saving = $state(false);

	onMount(async () => {
		try {
			list = await api<GoogleCalendar[]>(`/api/integrations/${connectionId}/calendars`);
		} catch (e) {
			failed = (e as Error).message;
		}
	});

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
						{#if cal.readOnly}<span title="Read-only"><Lock class="size-3 text-muted" /></span>{/if}
					</label>
				</li>
			{/each}
		</ul>
	{/if}
</div>
