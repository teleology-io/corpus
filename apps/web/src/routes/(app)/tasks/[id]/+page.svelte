<script lang="ts">
	import { formatDay, formatTime, localDate } from '#lib/calendar.js';
	import type { PageProps } from './$types';
	let { data }: PageProps = $props();
</script>

<div class="mx-auto w-full max-w-2xl space-y-4 p-6">
	<a href="/dashboard" class="text-sm text-muted">← Dashboard</a>
	<h1 class="text-2xl font-semibold">{data.task.title}</h1>
	<p class="text-sm text-muted">
		{data.task.completedAt ? 'Completed' : 'Open'}{#if data.task.dueAt}
			· Due {formatDay(localDate(new Date(data.task.dueAt), data.tz))}{#if !data.task.dueAllDay}
				at {formatTime(data.task.dueAt, data.tz)}{/if}{/if}
	</p>
	{#if data.task.notes}<p class="text-sm whitespace-pre-wrap text-ink">{data.task.notes}</p>{/if}
	{#if data.task.externalUrl}<a
			href={data.task.externalUrl}
			target="_blank"
			rel="noreferrer"
			class="text-sm text-primary-700">Open in {data.task.source}</a
		>{/if}
</div>
