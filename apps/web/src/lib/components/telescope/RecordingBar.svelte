<script lang="ts">
	import { page } from '$app/state';
	import { Pause, Play, Square } from '@lucide/svelte';
	import { fmtDuration } from '#lib/telescope.js';
	import {
		RECORD_PATH,
		discardRecording,
		pauseRecording,
		resumeRecording,
		session,
		stopRecording
	} from './session.svelte.js';

	const visible = $derived(
		['countdown', 'live', 'saving', 'failed'].includes(session.phase) &&
			page.url.pathname !== RECORD_PATH
	);
	const paused = $derived(session.recState === 'paused');
	const pct = $derived(session.total ? Math.round((session.uploaded / session.total) * 100) : 0);
</script>

{#if visible}
	<div
		class="recording-bar flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface px-4 text-sm"
		role="region"
		aria-label="Screen recording"
	>
		{#if session.phase === 'countdown'}
			<span class="font-medium">Recording starts in {session.count}…</span>
			<span class="flex-1"></span>
			<button class="btn-ghost h-8" onclick={discardRecording}>Cancel</button>
		{:else if session.phase === 'live'}
			<span
				class="size-2.5 shrink-0 rounded-full {paused
					? 'bg-amber-500'
					: 'animate-pulse bg-red-500'}"
			></span>
			<span class="font-semibold tabular-nums">{fmtDuration(session.elapsed)}</span>
			<a href={RECORD_PATH} class="truncate text-muted hover:text-ink">
				{paused ? 'Paused' : 'Recording'}
			</a>
			<span class="flex-1"></span>
			{#if paused}
				<button class="btn-outline h-8" onclick={resumeRecording}>
					<Play class="size-4" /> Resume
				</button>
			{:else}
				<button class="btn-outline h-8" onclick={pauseRecording}>
					<Pause class="size-4" /> Pause
				</button>
			{/if}
			<button class="btn-danger h-8" onclick={stopRecording}>
				<Square class="size-3.5 fill-current" /> Stop
			</button>
		{:else if session.phase === 'saving'}
			<span class="font-medium">Saving your recording…</span>
			<span class="text-muted tabular-nums">{pct}%</span>
		{:else}
			<span class="truncate font-medium text-red-600">Recording upload failed</span>
			<span class="flex-1"></span>
			<a href={RECORD_PATH} class="btn-outline h-8">Recover</a>
		{/if}
	</div>
{/if}
