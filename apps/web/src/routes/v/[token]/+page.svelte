<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { formatDistanceToNow } from 'date-fns';
	import Logo from '#lib/components/ui/Logo.svelte';
	import Player from '#lib/components/telescope/Player.svelte';
	import Transcript from '#lib/components/telescope/Transcript.svelte';
	import { fmtDuration } from '#lib/telescope.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const base = $derived(`/v/${data.token}`);
	let time = $state(0);

	/** A view counts after 2s of real playback, then heartbeats every 15s update watch time. */
	const FIRST_AFTER = 2000;
	const EVERY = 15_000;
	let sentAt = -1;
	let latest = 0;

	function send(watchedMs: number) {
		void fetch(`${base}/view`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ watchedMs: Math.round(watchedMs) }),
			keepalive: true
		}).catch(() => {});
	}

	function onwatch(ms: number) {
		latest = ms;
		if (data.isOwner || ms < FIRST_AFTER) return;
		if (sentAt < 0 || ms - sentAt >= EVERY) {
			sentAt = ms;
			send(ms);
		}
	}

	onMount(() => {
		const flush = () => {
			if (!data.isOwner && sentAt >= 0 && latest > sentAt) {
				sentAt = latest;
				send(latest);
			}
		};
		addEventListener('pagehide', flush);
		return () => removeEventListener('pagehide', flush);
	});
</script>

<svelte:head>
	<title>{data.video.title} · Corpus</title>
	<meta property="og:type" content="video.other" />
	<meta property="og:title" content={data.video.title} />
	<meta property="og:url" content={page.url.href} />
	{#if data.video.hasThumb}
		<meta property="og:image" content="{page.url.origin}{base}/thumb" />
		<meta name="twitter:card" content="summary_large_image" />
		<meta name="twitter:image" content="{page.url.origin}{base}/thumb" />
	{/if}
	<meta name="twitter:title" content={data.video.title} />
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="min-h-dvh bg-canvas">
	<header class="flex items-center gap-3 border-b border-line bg-surface px-6 py-3">
		<a href="/"><Logo size={24} /></a>
		{#if data.isOwner}
			<span class="ml-2 chip bg-primary-50 text-primary-600"
				>Your video — your views don’t count</span
			>
		{/if}
		{#if data.signedIn}
			<a href="/telescope" class="ml-auto btn-outline h-8 text-xs">Open Telescope</a>
		{:else}
			<a href="/sign-up" class="ml-auto btn-primary h-8 text-xs">Try Corpus</a>
		{/if}
	</header>
	<main class="mx-auto grid max-w-7xl gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:p-8">
		<div class="space-y-3">
			<Player
				src="{base}/media"
				captions={data.transcript.length ? `${base}/captions.vtt` : undefined}
				poster={data.video.hasThumb ? `${base}/thumb` : undefined}
				durationMs={data.video.durationMs}
				bind:time
				{onwatch}
			/>
			<div class="px-1">
				<h1 class="text-xl font-semibold">{data.video.title}</h1>
				<p class="mt-0.5 text-xs text-muted">
					{fmtDuration(data.video.durationMs)} · Recorded {formatDistanceToNow(
						new Date(data.video.createdAt),
						{ addSuffix: true }
					)}
				</p>
			</div>
		</div>
		{#if data.transcript.length}
			<div class="flex max-h-[calc(100dvh-140px)] min-h-80 flex-col overflow-hidden card">
				<p class="border-b border-line px-4 py-2.5 text-sm font-medium">Transcript</p>
				<Transcript segments={data.transcript} bind:time />
			</div>
		{/if}
	</main>
</div>
