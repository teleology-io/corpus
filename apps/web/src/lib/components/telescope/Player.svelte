<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		Play,
		Pause,
		Volume2,
		VolumeX,
		Maximize,
		Minimize,
		Captions,
		CaptionsOff
	} from '@lucide/svelte';
	import { fmtDuration } from '#lib/telescope.js';

	let {
		src,
		captions,
		poster,
		durationMs,
		time = $bindable(0),
		onwatch
	}: {
		src: string;
		captions?: string;
		poster?: string;
		/** Recorded duration from the DB — MediaRecorder files often don't carry one. */
		durationMs: number;
		/** Current position in seconds; set it to seek. */
		time?: number;
		/** Cumulative seconds of real playback this session, reported as it grows. */
		onwatch?: (watchedMs: number) => void;
	} = $props();

	let video: HTMLVideoElement | undefined = $state();
	let wrap: HTMLDivElement | undefined = $state();
	let paused = $state(true);
	let muted = $state(false);
	let rate = $state(1);
	let ccOn = $state(true);
	let fullscreen = $state(false);
	let mediaDuration = $state(Infinity);
	let started = $state(false);
	let scrubbing = $state(false);
	let fixingDuration = false;
	let lastTick = 0;
	let watched = 0;

	const duration = $derived(
		Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration : durationMs / 1000
	);
	const RATES = [1, 1.25, 1.5, 2];

	/** Seek requests from outside (transcript clicks) arrive through `time`. */
	let reported = 0;
	$effect(() => {
		if (!video || scrubbing) return;
		if (Math.abs(time - reported) > 0.3) {
			video.currentTime = time;
			reported = time;
			if (video.paused) void video.play();
		}
	});

	function onMeta() {
		if (!video) return;
		mediaDuration = video.duration;
		// MediaRecorder WebM/fMP4 has no duration header; seeking far past the end makes the
		// browser scan to the real end, after which the scrubber and seeking behave normally.
		if (!Number.isFinite(video.duration)) {
			fixingDuration = true;
			video.currentTime = 1e101;
		}
	}

	function onDurationChange() {
		if (!video) return;
		mediaDuration = video.duration;
		if (fixingDuration && Number.isFinite(video.duration)) {
			fixingDuration = false;
			video.currentTime = 0;
		}
	}

	function onTime() {
		if (!video || fixingDuration) return;
		time = reported = video.currentTime;
		const now = performance.now();
		if (!video.paused && lastTick) {
			const dt = now - lastTick;
			// Ignore jumps (tab was asleep, seek); count only steady playback.
			if (dt < 1500) {
				watched += dt * video.playbackRate;
				onwatch?.(watched);
			}
		}
		lastTick = video.paused ? 0 : now;
	}

	function toggle() {
		if (!video) return;
		started = true;
		if (video.paused) void video.play();
		else video.pause();
	}

	function seekFromPointer(e: PointerEvent, bar: HTMLElement) {
		const r = bar.getBoundingClientRect();
		const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration;
		time = reported = t;
		if (video) video.currentTime = t;
	}

	function scrubStart(e: PointerEvent) {
		const bar = e.currentTarget as HTMLElement;
		scrubbing = true;
		bar.setPointerCapture(e.pointerId);
		seekFromPointer(e, bar);
	}

	function scrubMove(e: PointerEvent) {
		if (scrubbing) seekFromPointer(e, e.currentTarget as HTMLElement);
	}

	function cycleRate() {
		rate = RATES[(RATES.indexOf(rate) + 1) % RATES.length]!;
		if (video) video.playbackRate = rate;
	}

	function setCaptions(on: boolean) {
		ccOn = on;
		const track = video?.textTracks[0];
		if (track) track.mode = on ? 'showing' : 'hidden';
	}

	async function toggleFullscreen() {
		if (document.fullscreenElement) await document.exitFullscreen();
		else await wrap?.requestFullscreen();
	}

	function onKey(e: KeyboardEvent) {
		if (!video) return;
		if (e.key === ' ' || e.key === 'k') {
			e.preventDefault();
			toggle();
		} else if (e.key === 'ArrowRight')
			video.currentTime = Math.min(duration, video.currentTime + 5);
		else if (e.key === 'ArrowLeft') video.currentTime = Math.max(0, video.currentTime - 5);
		else if (e.key === 'm') muted = !muted;
		else if (e.key === 'f') void toggleFullscreen();
		else if (e.key === 'c') setCaptions(!ccOn);
	}

	const onFs = () => (fullscreen = !!document.fullscreenElement);
	if (typeof document !== 'undefined') document.addEventListener('fullscreenchange', onFs);
	onDestroy(() => {
		if (typeof document !== 'undefined') document.removeEventListener('fullscreenchange', onFs);
	});

	const pct = $derived(duration ? Math.min(100, (time / duration) * 100) : 0);
</script>

<!-- Keyboard shortcuts (space/k, arrows, m, f, c) apply while the player has focus. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
	bind:this={wrap}
	class="group relative overflow-hidden rounded-xl bg-black outline-none {fullscreen
		? 'flex items-center'
		: ''}"
	role="region"
	aria-label="Video player"
	tabindex="0"
	onkeydown={onKey}
>
	<!-- svelte-ignore a11y_media_has_caption -->
	<video
		bind:this={video}
		bind:paused
		bind:muted
		{src}
		{poster}
		preload="metadata"
		playsinline
		class="aspect-video w-full bg-black object-contain"
		onclick={toggle}
		onloadedmetadata={onMeta}
		ondurationchange={onDurationChange}
		ontimeupdate={onTime}
		onplay={() => ((started = true), (lastTick = performance.now()))}
		onpause={() => (lastTick = 0)}
	>
		{#if captions}
			<track
				kind="captions"
				srclang="en"
				label="English"
				src={captions}
				default
				onload={() => setCaptions(ccOn)}
			/>
		{/if}
	</video>

	{#if !started}
		<button
			class="absolute inset-0 flex items-center justify-center bg-black/20 transition-colors hover:bg-black/30"
			aria-label="Play"
			onclick={toggle}
		>
			<span
				class="flex size-16 items-center justify-center rounded-full bg-primary-500 text-white shadow-lg"
				><Play class="ml-1 size-7 fill-current" /></span
			>
		</button>
	{/if}

	<div
		class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-3 pt-8 pb-2 text-white transition-opacity {paused ||
		scrubbing
			? 'opacity-100'
			: 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100'}"
	>
		<div
			class="relative h-4 cursor-pointer touch-none"
			role="slider"
			tabindex="-1"
			aria-label="Seek"
			aria-valuemin={0}
			aria-valuemax={Math.round(duration)}
			aria-valuenow={Math.round(time)}
			onpointerdown={scrubStart}
			onpointermove={scrubMove}
			onpointerup={() => (scrubbing = false)}
			onpointercancel={() => (scrubbing = false)}
		>
			<div class="absolute inset-x-0 top-1.5 h-1 rounded-full bg-white/30">
				<div class="h-full rounded-full bg-primary-500" style:width="{pct}%"></div>
			</div>
			<div
				class="absolute top-0.5 size-3 -translate-x-1/2 rounded-full bg-white shadow"
				style:left="{pct}%"
			></div>
		</div>
		<div class="mt-1 flex items-center gap-1 text-xs">
			<button
				class="rounded p-1.5 hover:bg-white/15"
				aria-label={paused ? 'Play' : 'Pause'}
				onclick={toggle}
			>
				{#if paused}<Play class="size-4 fill-current" />{:else}<Pause
						class="size-4 fill-current"
					/>{/if}
			</button>
			<button
				class="rounded p-1.5 hover:bg-white/15"
				aria-label={muted ? 'Unmute' : 'Mute'}
				onclick={() => (muted = !muted)}
			>
				{#if muted}<VolumeX class="size-4" />{:else}<Volume2 class="size-4" />{/if}
			</button>
			<span class="ml-1 tabular-nums"
				>{fmtDuration(time * 1000)} / {fmtDuration(duration * 1000)}</span
			>
			<span class="flex-1"></span>
			<button
				class="rounded px-2 py-1 font-semibold tabular-nums hover:bg-white/15"
				aria-label="Playback speed"
				onclick={cycleRate}>{rate}×</button
			>
			{#if captions}
				<button
					class="rounded p-1.5 hover:bg-white/15"
					aria-label={ccOn ? 'Hide captions' : 'Show captions'}
					onclick={() => setCaptions(!ccOn)}
				>
					{#if ccOn}<Captions class="size-4" />{:else}<CaptionsOff class="size-4" />{/if}
				</button>
			{/if}
			<button
				class="rounded p-1.5 hover:bg-white/15"
				aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
				onclick={toggleFullscreen}
			>
				{#if fullscreen}<Minimize class="size-4" />{:else}<Maximize class="size-4" />{/if}
			</button>
		</div>
	</div>
</div>
