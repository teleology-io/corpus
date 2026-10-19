<script lang="ts">
	import { Repeat } from '@lucide/svelte';
	import Icon from '../ui/Icon.svelte';
	import AvatarStack from '../ui/AvatarStack.svelte';
	import { formatTime, tint } from '#lib/calendar.js';
	import type { OccurrenceDTO } from '#lib/types.js';

	let {
		occ,
		tz,
		height = 999,
		compact = false
	}: { occ: OccurrenceDTO; tz: string; height?: number; compact?: boolean } = $props();

	const color = $derived(occ.color);
	const alpha = $derived(occ.opacity / 100);
	const showTime = $derived(height >= 44);
	const showPeople = $derived(height >= 92 && occ.attendees.length > 0);
</script>

<div
	class="flex h-full w-full flex-col overflow-hidden rounded-lg border px-2 py-1.5 text-left"
	style:background={tint(color, 0.08 * alpha + 0.02)}
	style:border-color={tint(color, 0.45 * alpha + 0.1)}
	style:color
>
	<div class="flex min-w-0 items-start gap-1.5">
		{#if !compact}
			<span class="mt-px shrink-0 rounded p-0.5" style:background={tint(color, 0.15)}>
				<Icon name={occ.category?.icon ?? 'calendar'} class="size-3" />
			</span>
		{/if}
		<span class="line-clamp-2 min-w-0 flex-1 text-xs leading-tight font-semibold">{occ.title}</span>
		{#if occ.recurring && !compact}<Repeat class="mt-0.5 size-3 shrink-0 opacity-60" />{/if}
	</div>
	{#if showTime}
		<p class="mt-0.5 truncate text-[11px] opacity-80">
			{occ.allDay ? 'All day' : `${formatTime(occ.start, tz)} - ${formatTime(occ.end, tz)}`}
		</p>
	{/if}
	{#if showPeople}
		<div class="mt-auto pt-1"><AvatarStack people={occ.attendees} size={20} /></div>
	{/if}
</div>
