<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { Check, SquareTerminal, ArrowUpRight } from '@lucide/svelte';
	import { api } from '#lib/api.js';
	import { attempt } from '#lib/stores/toast.svelte.js';
	import type { WorkbenchTaskDTO } from '#lib/types.js';

	let { tasks }: { tasks: WorkbenchTaskDTO[] } = $props();

	// Optimistic completion state keyed by task id
	let optimistic = $state<Record<string, boolean>>({});
	const isDone = (t: WorkbenchTaskDTO) => optimistic[t.id] ?? t.status === 'done';
	const where = (t: WorkbenchTaskDTO) => [t.project, t.workspace].filter(Boolean).join(' / ');

	async function toggle(t: WorkbenchTaskDTO) {
		const next = !isDone(t);
		optimistic[t.id] = next;
		await attempt(() =>
			api('/api/wrx/task-status', { body: { id: t.id, status: next ? 'done' : 'todo' } })
		);
		await refreshAll();
		delete optimistic[t.id];
	}
</script>

<p
	class="mt-4 mb-1 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-gray-400 uppercase"
>
	<SquareTerminal class="size-3.5" /> Workbench
</p>
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
				<p class="flex items-center gap-1.5 truncate text-[11px] text-muted">
					{#if t.status === 'doing' && !done}<span class="font-medium text-amber-600"
							>In progress</span
						>{/if}
					<span class="truncate">{where(t)}</span>
				</p>
			</div>
			<a
				href="/workbench?workspace={t.workspaceId}&tab=tasks"
				class="text-muted opacity-0 group-hover:opacity-100 hover:text-ink pointer-coarse:opacity-100"
				aria-label="Open in Workbench"
				title="Open in Workbench"><ArrowUpRight class="size-3.5" /></a
			>
		</li>
	{/each}
</ul>
