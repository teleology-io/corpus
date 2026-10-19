<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { Check, Plus, Trash2, ExternalLink, Flag } from '@lucide/svelte';
	import BrandIcon from '../ui/BrandIcon.svelte';
	import { api } from '#lib/api.js';
	import { attempt } from '#lib/stores/toast.svelte.js';
	import { atLocal, formatTime } from '#lib/calendar.js';
	import type { TaskDTO } from '#lib/types.js';

	let {
		tasks,
		tz,
		dueDate = null,
		placeholder = 'Add a task…',
		emptyText = 'Nothing to do. Nice.',
		addable = true
	}: {
		tasks: TaskDTO[];
		tz: string;
		dueDate?: string | null;
		placeholder?: string;
		emptyText?: string;
		addable?: boolean;
	} = $props();

	let draft = $state('');
	// Optimistic completion state keyed by task id
	let optimistic = $state<Record<string, boolean>>({});

	const isDone = (t: TaskDTO) => optimistic[t.id] ?? !!t.completedAt;
	const overdue = (t: TaskDTO) =>
		!t.completedAt && t.dueAt && dueDate && new Date(t.dueAt) < atLocal(dueDate, '00:00', tz);
	const PRIORITY = ['', 'text-sky-500', 'text-amber-500', 'text-red-500'];

	async function add(e: SubmitEvent) {
		e.preventDefault();
		const title = draft.trim();
		if (!title) return;
		draft = '';
		await attempt(() =>
			api('/api/tasks', {
				body: {
					title,
					dueAt: dueDate ? atLocal(dueDate, '12:00', tz).toISOString() : null,
					dueAllDay: true
				}
			})
		);
		await refreshAll();
	}

	async function toggle(t: TaskDTO) {
		const next = !isDone(t);
		optimistic[t.id] = next;
		await attempt(() => api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { completed: next } }));
		await refreshAll();
		delete optimistic[t.id];
	}

	async function remove(t: TaskDTO) {
		await attempt(() => api(`/api/tasks/${t.id}`, { method: 'DELETE' }));
		await refreshAll();
	}
</script>

<ul class="divide-y divide-line/70">
	{#each tasks as t (t.id)}
		{@const done = isDone(t)}
		<li class="group flex items-center gap-3 py-2.5">
			<button
				class="flex size-5 shrink-0 items-center justify-center rounded-md border-2 transition-colors {done
					? 'border-primary-500 bg-primary-500 text-white'
					: 'border-gray-300 hover:border-primary-400'}"
				aria-label={done ? 'Mark incomplete' : 'Mark complete'}
				onclick={() => toggle(t)}
			>
				{#if done}<Check class="size-3" strokeWidth={3} />{/if}
			</button>
			<div class="min-w-0 flex-1">
				<p class="truncate text-sm {done ? 'text-gray-400 line-through' : 'text-ink'}">{t.title}</p>
				{#if overdue(t) || (t.dueAt && !t.dueAllDay) || t.source !== 'manual'}
					<p class="flex items-center gap-1.5 text-[11px] text-muted">
						{#if t.source !== 'manual'}<BrandIcon name={t.source} class="size-3" />{/if}
						{#if overdue(t)}<span class="font-medium text-red-600">Overdue</span>{/if}
						{#if t.dueAt && !t.dueAllDay}<span>{formatTime(t.dueAt, tz)}</span>{/if}
					</p>
				{/if}
			</div>
			{#if t.priority > 0}<Flag
					class="size-3.5 {PRIORITY[t.priority]}"
					aria-label="Priority {t.priority}"
				/>{/if}
			{#if t.externalUrl}
				<a
					href={t.externalUrl}
					target="_blank"
					rel="noreferrer"
					class="text-muted hover:text-ink"
					aria-label="Open"><ExternalLink class="size-3.5" /></a
				>
			{/if}
			<button
				class="text-gray-300 opacity-0 group-hover:opacity-100 hover:text-red-600"
				aria-label="Delete task"
				onclick={() => remove(t)}><Trash2 class="size-3.5" /></button
			>
		</li>
	{:else}
		<li class="py-4 text-center text-xs text-muted">{emptyText}</li>
	{/each}
</ul>

{#if addable}
	<form class="mt-2 flex items-center gap-2" onsubmit={add}>
		<Plus class="size-4 text-muted" />
		<input
			class="h-9 flex-1 bg-transparent text-sm outline-none placeholder:text-gray-400"
			{placeholder}
			bind:value={draft}
		/>
	</form>
{/if}
