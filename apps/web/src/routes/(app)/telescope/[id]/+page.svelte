<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { DropdownMenu } from 'bits-ui';
	import { formatDistanceToNow } from 'date-fns';
	import {
		ArrowLeft,
		MoreHorizontal,
		Trash2,
		Download,
		Eye,
		UserRound,
		VenetianMask,
		FileText,
		RefreshCw,
		Loader2
	} from '@lucide/svelte';
	import Player from '#lib/components/telescope/Player.svelte';
	import Transcript from '#lib/components/telescope/Transcript.svelte';
	import ShareButton from '#lib/components/telescope/ShareButton.svelte';
	import Avatar from '#lib/components/ui/Avatar.svelte';
	import { describeJob, jobs, startTranscription } from '#lib/components/telescope/jobs.svelte.js';
	import { fmtDuration, plural } from '#lib/telescope.js';
	import { api } from '#lib/api.js';
	import { attempt, toast } from '#lib/stores/toast.svelte.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const v = $derived(data.video);
	let time = $state(0);
	let tab = $state<'transcript' | 'viewers'>('transcript');
	let title = $derived(data.video.title);
	let linkToken = $derived(data.video.linkToken);

	const job = $derived(jobs[v.id]);
	// Reload the saved transcript once a background job finishes.
	let seenDone = false;
	$effect(() => {
		if (job?.status === 'done' && !seenDone) {
			seenDone = true;
			void invalidateAll();
		}
		if (job?.status === 'running') seenDone = false;
	});

	async function saveTitle() {
		const t = title.trim();
		if (!t || t === v.title) return void (title = v.title);
		await attempt(() => api(`/api/telescope/${v.id}`, { method: 'PATCH', body: { title: t } }));
		await invalidateAll();
	}

	async function destroy() {
		if (!confirm('Delete this recording permanently? Anyone with the link loses access.')) return;
		const ok = await attempt(async () => {
			await api(`/api/telescope/${v.id}`, { method: 'DELETE' });
			return true;
		});
		if (ok) {
			toast('Recording deleted', { tone: 'success' });
			await goto('/telescope');
		}
	}

	const watchPct = (ms: number) =>
		v.durationMs ? Math.min(100, Math.round((ms / v.durationMs) * 100)) : 0;
</script>

<svelte:head><title>{v.title} · Telescope · Corpus</title></svelte:head>

<div class="space-y-4 p-4 lg:p-8">
	<div class="flex items-center gap-2">
		<a href="/telescope" class="btn-icon size-8" aria-label="All recordings"
			><ArrowLeft class="size-4" /></a
		>
		<input
			class="min-w-0 flex-1 rounded-lg bg-transparent px-2 py-1 text-lg font-semibold outline-none hover:bg-canvas focus:bg-canvas"
			aria-label="Title"
			bind:value={title}
			onblur={saveTitle}
			onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
		/>
		<ShareButton videoId={v.id} bind:linkToken />
		<DropdownMenu.Root>
			<DropdownMenu.Trigger class="btn-icon size-8" aria-label="More"
				><MoreHorizontal class="size-4" /></DropdownMenu.Trigger
			>
			<DropdownMenu.Portal>
				<DropdownMenu.Content class="menu w-48" align="end" sideOffset={6}>
					<DropdownMenu.Item
						class="menu-item"
						onSelect={() => window.open(`/api/telescope/${v.id}/media`, '_blank')}
						><Download class="size-4 text-muted" /> Download</DropdownMenu.Item
					>
					{#if v.transcriptStatus !== 'pending' && job?.status !== 'running'}
						<DropdownMenu.Item class="menu-item" onSelect={() => startTranscription(v.id)}
							><RefreshCw class="size-4 text-muted" /> Re-transcribe</DropdownMenu.Item
						>
					{/if}
					<DropdownMenu.Item class="menu-item text-red-600" onSelect={destroy}
						><Trash2 class="size-4" /> Delete</DropdownMenu.Item
					>
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	</div>

	<div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
		<div class="space-y-3">
			<Player
				src="/api/telescope/{v.id}/media"
				captions={data.transcript.length ? `/api/telescope/${v.id}/captions.vtt` : undefined}
				poster={v.hasThumb ? `/api/telescope/${v.id}/thumb` : undefined}
				durationMs={v.durationMs}
				bind:time
			/>
			<div class="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted">
				<span>Recorded {formatDistanceToNow(new Date(v.createdAt), { addSuffix: true })}</span>
				<span>{fmtDuration(v.durationMs)}</span>
				<span class="ml-auto flex items-center gap-1 font-medium text-ink"
					><Eye class="size-3.5" /> {plural(v.views.total, 'view')}</span
				>
				<span class="flex items-center gap-1" title="Signed-in viewers"
					><UserRound class="size-3.5" /> {v.views.authed} signed in</span
				>
				<span class="flex items-center gap-1" title="Viewers without an account"
					><VenetianMask class="size-3.5" /> {v.views.anon} anonymous</span
				>
			</div>
		</div>

		<div class="flex max-h-[calc(100dvh-180px)] min-h-80 flex-col overflow-hidden card">
			<div class="flex border-b border-line px-2">
				{#each [{ id: 'transcript', label: 'Transcript' }, { id: 'viewers', label: `Viewers (${v.views.total})` }] as t (t.id)}
					<button
						class="-mb-px border-b-2 px-3 py-2.5 text-sm font-medium {tab === t.id
							? 'border-primary-500 text-ink'
							: 'border-transparent text-muted hover:text-ink'}"
						onclick={() => (tab = t.id as typeof tab)}>{t.label}</button
					>
				{/each}
			</div>

			{#if tab === 'transcript'}
				{#if job?.status === 'running'}
					<div class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
						<Loader2 class="size-5 animate-spin text-primary-500" />
						<p class="text-sm font-medium">{describeJob(job)}</p>
						<div class="h-1.5 w-48 overflow-hidden rounded-full bg-canvas">
							<div
								class="h-full bg-primary-500 transition-[width]"
								style:width="{Math.round(job.progress.fraction * 100)}%"
							></div>
						</div>
						<p class="max-w-xs text-xs text-muted">
							Runs on this device. Keep the tab open until it finishes.
						</p>
					</div>
				{:else if v.transcriptStatus === 'done' && data.transcript.length}
					<Transcript segments={data.transcript} bind:time />
				{:else}
					<div class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
						<FileText class="size-5 text-gray-300" />
						<p class="text-sm font-medium">
							{#if v.transcriptStatus === 'done'}No speech detected
							{:else if v.transcriptStatus === 'failed' || job?.status === 'failed'}Transcription
								failed
							{:else}No transcript yet{/if}
						</p>
						{#if job?.error}<p class="max-w-xs text-xs text-muted">{job.error}</p>{/if}
						<p class="max-w-xs text-xs text-muted">
							English only. The speech model (~175 MB) downloads once, then is cached.
						</p>
						<button class="btn-outline h-8 text-xs" onclick={() => startTranscription(v.id)}
							><RefreshCw class="size-3.5" />
							{v.transcriptStatus === 'pending' ? 'Transcribe' : 'Try again'}</button
						>
					</div>
				{/if}
			{:else}
				<div class="min-h-0 flex-1 scrollbar-thin overflow-y-auto p-2">
					{#if v.views.anon}
						<div class="flex items-center gap-3 rounded-lg px-2 py-2">
							<span
								class="flex size-7 items-center justify-center rounded-full bg-canvas text-muted"
								><VenetianMask class="size-3.5" /></span
							>
							<p class="text-sm text-muted">
								{plural(v.views.anon, 'anonymous viewer')}
							</p>
						</div>
					{/if}
					{#each data.viewers as p (p.email)}
						<div class="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-canvas">
							<Avatar name={p.name} image={p.image} size={28} />
							<div class="min-w-0 flex-1">
								<p class="truncate text-sm font-medium">{p.name}</p>
								<p class="text-xs text-muted">
									Watched {watchPct(p.watchedMs)}% · {formatDistanceToNow(new Date(p.lastSeenAt), {
										addSuffix: true
									})}
								</p>
							</div>
						</div>
					{:else}
						{#if !v.views.anon}
							<p class="px-2 py-8 text-center text-xs text-muted">
								{linkToken
									? 'No one has watched yet. Views count after 2 seconds of playback.'
									: 'Only you can see this. Turn on the link in Share to let others watch.'}
							</p>
						{/if}
					{/each}
				</div>
			{/if}
		</div>
	</div>
</div>
