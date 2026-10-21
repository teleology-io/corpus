<script lang="ts">
	import { Telescope, Plus, Lock, Link2, Eye, Video } from '@lucide/svelte';
	import { formatDistanceToNow } from 'date-fns';
	import EmptyState from '#lib/components/ui/EmptyState.svelte';
	import { fmtDuration, plural } from '#lib/telescope.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head><title>Telescope · Corpus</title></svelte:head>

<div class="space-y-6 p-4 lg:p-8">
	<div class="flex flex-wrap items-center gap-3">
		<div>
			<h2 class="text-lg font-semibold">Telescope</h2>
			<p class="text-sm text-muted">
				Record your screen, a window or a tab — transcribed on your device, private until you share
				it.
			</p>
		</div>
		<a href="/telescope/record" class="ml-auto btn-primary"><Plus class="size-4" /> New recording</a
		>
	</div>

	{#if !data.videos.length}
		<div class="card">
			<EmptyState
				title="No recordings yet"
				body="Walk someone through a bug, a design or a plan without scheduling a meeting."
			>
				{#snippet icon()}<Telescope class="size-5" />{/snippet}
				{#snippet action()}<a href="/telescope/record" class="btn-primary"
						><Video class="size-4" /> Record your first video</a
					>{/snippet}
			</EmptyState>
		</div>
	{:else}
		<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
			{#each data.videos as v (v.id)}
				<a
					href="/telescope/{v.id}"
					class="group overflow-hidden card transition-shadow hover:shadow-pop"
				>
					<div class="relative aspect-video bg-canvas">
						{#if v.hasThumb}
							<img
								src="/api/telescope/{v.id}/thumb"
								alt=""
								loading="lazy"
								class="size-full object-cover"
							/>
						{:else}
							<div class="flex size-full items-center justify-center text-gray-300">
								<Video class="size-8" />
							</div>
						{/if}
						<span
							class="absolute right-2 bottom-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white tabular-nums"
							>{fmtDuration(v.durationMs)}</span
						>
					</div>
					<div class="space-y-1.5 p-3">
						<p class="truncate text-sm font-semibold text-ink group-hover:text-primary-600">
							{v.title}
						</p>
						<div class="flex items-center gap-2 text-xs text-muted">
							<span>{formatDistanceToNow(new Date(v.createdAt), { addSuffix: true })}</span>
							<span
								class="ml-auto flex items-center gap-1"
								title="{v.views.authed} signed in · {v.views.anon} anonymous"
								><Eye class="size-3.5" /> {plural(v.views.total, 'view')}</span
							>
							{#if v.visibility === 'link'}
								<span class="chip bg-primary-50 text-primary-600"
									><Link2 class="size-3" /> Link</span
								>
							{:else}
								<span class="chip bg-canvas text-muted"><Lock class="size-3" /> Private</span>
							{/if}
						</div>
					</div>
				</a>
			{/each}
		</div>
	{/if}
</div>
