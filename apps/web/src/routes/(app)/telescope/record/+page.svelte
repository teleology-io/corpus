<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		Monitor,
		AppWindow,
		PanelTop,
		Camera,
		Mic,
		MicOff,
		Pause,
		Play,
		Square,
		Trash2,
		Circle,
		Download,
		Info,
		ArrowLeft
	} from '@lucide/svelte';
	import {
		Recorder,
		canCaptureTab,
		canRecordScreen,
		listDevices,
		systemAudioLikely,
		type Mode,
		type RecorderState,
		type Recording,
		type Surface
	} from '#lib/components/telescope/recorder.js';
	import {
		PartUploader,
		completeDraft,
		createDraft,
		uploadThumb
	} from '#lib/components/telescope/upload.js';
	import { startTranscription } from '#lib/components/telescope/jobs.svelte.js';
	import { fmtDuration } from '#lib/telescope.js';
	import { toast } from '#lib/stores/toast.svelte.js';

	type Phase = 'setup' | 'preparing' | 'countdown' | 'live' | 'saving' | 'failed';

	const PREFS = 'corpus:telescope:prefs';
	const screenOk = canRecordScreen();
	const tabOk = canCaptureTab();

	let mode = $state<Mode>(screenOk ? 'screen' : 'camera');
	let surface = $state<Surface>('monitor');
	/** '' = system default device, 'none' = no mic */
	let micId = $state('');
	let cameraId = $state('');
	let mics = $state<MediaDeviceInfo[]>([]);
	let cameras = $state<MediaDeviceInfo[]>([]);

	let phase = $state<Phase>('setup');
	let recState = $state<RecorderState>('idle');
	let count = $state(3);
	let elapsed = $state(0);
	let level = $state(0);
	let uploaded = $state(0);
	let total = $state(0);
	let saveError = $state('');
	let previewEl: HTMLVideoElement | undefined = $state();

	let recorder: Recorder | null = null;
	let uploader: PartUploader | null = null;
	let videoId: string | null = null;
	let failedRecording: Recording | null = null;
	let raf = 0;
	let countdownTimer: ReturnType<typeof setInterval> | undefined;

	const surfaces: { id: Surface; label: string; icon: typeof Monitor; hint: string }[] = [
		{ id: 'monitor', label: 'Entire desktop', icon: Monitor, hint: 'A whole screen' },
		{ id: 'window', label: 'Window', icon: AppWindow, hint: 'One app window' },
		...(tabOk
			? [
					{
						id: 'browser' as Surface,
						label: 'Browser tab',
						icon: PanelTop,
						hint: 'Includes tab audio'
					}
				]
			: [])
	];
	const modes: { id: Mode; label: string }[] = [
		...(screenOk
			? [
					{ id: 'screen' as Mode, label: 'Screen only' },
					{ id: 'screen-camera' as Mode, label: 'Screen + camera' }
				]
			: []),
		{ id: 'camera', label: 'Camera only' }
	];
	const audioHint = $derived.by(() => {
		if (mode === 'camera') return null;
		if (surface === 'browser') return 'Tab audio is recorded along with your mic.';
		if (systemAudioLikely())
			return 'Tick “Share system audio” in the picker to include computer sound.';
		return 'Computer sound isn’t captured for a desktop or window here — share a browser tab if you need its audio. Your mic is always recorded.';
	});

	async function refreshDevices() {
		const d = await listDevices();
		mics = d.mics;
		cameras = d.cameras;
	}

	onMount(() => {
		try {
			const p = JSON.parse(localStorage.getItem(PREFS) ?? '{}');
			if (p.mode && modes.some((m) => m.id === p.mode)) mode = p.mode;
			if (p.surface && surfaces.some((s) => s.id === p.surface)) surface = p.surface;
			if (typeof p.micId === 'string') micId = p.micId;
			if (typeof p.cameraId === 'string') cameraId = p.cameraId;
		} catch {
			/* ignore */
		}
		void refreshDevices();
		navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
		window.addEventListener('beforeunload', guardUnload);
	});

	onDestroy(() => {
		cancelAnimationFrame(raf);
		clearInterval(countdownTimer);
		if (typeof window === 'undefined') return;
		navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices);
		window.removeEventListener('beforeunload', guardUnload);
		if (recorder && recorder.state !== 'stopped') void discard();
	});

	function guardUnload(e: BeforeUnloadEvent) {
		if (phase === 'live' || phase === 'saving' || phase === 'countdown') e.preventDefault();
	}

	function tick() {
		if (!recorder) return;
		elapsed = recorder.elapsedMs();
		level = recorder.level();
		raf = requestAnimationFrame(tick);
	}

	async function begin() {
		localStorage.setItem(PREFS, JSON.stringify({ mode, surface, micId, cameraId }));
		phase = 'preparing';
		try {
			recorder = new Recorder({
				onstate: (s) => (recState = s),
				onchunk: (c) => uploader?.push(c),
				onended: () => {
					if (phase === 'live') void stop();
					else if (phase === 'countdown') void discard();
				}
			});
			await recorder.prepare({
				mode,
				surface,
				micId: micId === 'none' ? null : micId || '',
				cameraId: cameraId || null
			});
			// Permission granted → labels are available now.
			void refreshDevices();
			const draft = await createDraft(recorder.mime);
			videoId = draft.id;
			uploader = new PartUploader(draft.id, (u, t) => ((uploaded = u), (total = t)));
		} catch (e) {
			recorder?.discard();
			recorder = null;
			phase = 'setup';
			toast('Could not start recording', { tone: 'error', body: (e as Error).message });
			return;
		}
		phase = 'countdown';
		count = 3;
		countdownTimer = setInterval(() => {
			count -= 1;
			if (count > 0) return;
			clearInterval(countdownTimer);
			goLive();
		}, 1000);
	}

	function goLive() {
		if (!recorder) return;
		phase = 'live';
		recorder.start();
		raf = requestAnimationFrame(tick);
	}

	// The preview element mounts once phase flips to 'live'.
	$effect(() => {
		if (previewEl && recorder?.preview) previewEl.srcObject = recorder.preview;
	});

	async function stop() {
		if (!recorder || !uploader || !videoId) return;
		cancelAnimationFrame(raf);
		phase = 'saving';
		const recording = await recorder.stop();
		recorder = null;
		if (!recording.blob.size) {
			await discard();
			toast('Nothing was recorded', { tone: 'error' });
			return;
		}
		try {
			const parts = await uploader.finish();
			await completeDraft(videoId, {
				parts,
				durationMs: recording.durationMs,
				width: recording.width,
				height: recording.height
			});
			if (recording.thumb) await uploadThumb(videoId, recording.thumb).catch(() => {});
			// Runs in the background (module state), so it continues on the video page.
			void startTranscription(videoId, recording.blob);
			phase = 'setup';
			await goto(`/telescope/${videoId}`);
		} catch (e) {
			failedRecording = recording;
			saveError = (e as Error).message;
			phase = 'failed';
		}
	}

	async function discard() {
		clearInterval(countdownTimer);
		cancelAnimationFrame(raf);
		recorder?.discard();
		recorder = null;
		uploader = null;
		const id = videoId;
		videoId = null;
		phase = 'setup';
		if (id) await fetch(`/api/telescope/${id}`, { method: 'DELETE' }).catch(() => {});
	}

	function downloadFailed() {
		if (!failedRecording) return;
		const a = document.createElement('a');
		a.href = URL.createObjectURL(failedRecording.blob);
		a.download = `recording.${failedRecording.mime.includes('mp4') ? 'mp4' : 'webm'}`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
	}

	const pctUploaded = $derived(total ? Math.round((uploaded / total) * 100) : 0);
</script>

<svelte:head><title>New recording · Telescope · Corpus</title></svelte:head>

<div class="mx-auto max-w-3xl space-y-6 p-4 lg:p-8">
	<a href="/telescope" class="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
		><ArrowLeft class="size-4" /> All recordings</a
	>

	{#if phase === 'setup' || phase === 'preparing'}
		<div class="space-y-6 card p-5">
			<div>
				<h2 class="text-lg font-semibold">New recording</h2>
				<p class="text-sm text-muted">
					Your browser asks what to share next. Recordings stay private until you turn on the link.
				</p>
			</div>

			{#if !screenOk}
				<p class="flex gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
					<Info class="size-4 shrink-0" /> This browser can’t capture the screen (phones and tablets can’t).
					Use a desktop browser to record your screen — camera-only works here.
				</p>
			{/if}

			<div>
				<p class="label">Record</p>
				<div class="flex flex-wrap gap-2">
					{#each modes as m (m.id)}
						<button
							class="btn h-9 border {mode === m.id
								? 'border-primary-500 bg-primary-50 text-primary-600'
								: 'border-line bg-surface text-ink hover:bg-canvas'}"
							onclick={() => (mode = m.id)}>{m.label}</button
						>
					{/each}
				</div>
			</div>

			{#if mode !== 'camera'}
				<div>
					<p class="label">What to share</p>
					<div class="grid gap-2 sm:grid-cols-3">
						{#each surfaces as s (s.id)}
							<button
								class="flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-colors {surface ===
								s.id
									? 'border-primary-500 bg-primary-50'
									: 'border-line hover:bg-canvas'}"
								onclick={() => (surface = s.id)}
							>
								<s.icon class="size-5 {surface === s.id ? 'text-primary-500' : 'text-gray-400'}" />
								<span class="text-sm font-medium">{s.label}</span>
								<span class="text-xs text-muted">{s.hint}</span>
							</button>
						{/each}
					</div>
					{#if audioHint}<p class="mt-2 text-xs text-muted">{audioHint}</p>{/if}
				</div>
			{/if}

			<div class="grid gap-4 sm:grid-cols-2">
				<label class="block">
					<span class="label flex items-center gap-1.5"><Mic class="size-3.5" /> Microphone</span>
					<select class="input" bind:value={micId}>
						<option value="">Default microphone</option>
						{#each mics.filter((d) => d.deviceId && d.deviceId !== 'default') as d (d.deviceId)}
							<option value={d.deviceId}>{d.label || 'Microphone'}</option>
						{/each}
						<option value="none">No microphone</option>
					</select>
				</label>
				{#if mode !== 'screen'}
					<label class="block">
						<span class="label flex items-center gap-1.5"><Camera class="size-3.5" /> Camera</span>
						<select class="input" bind:value={cameraId}>
							<option value="">Default camera</option>
							{#each cameras.filter((d) => d.deviceId) as d (d.deviceId)}
								<option value={d.deviceId}>{d.label || 'Camera'}</option>
							{/each}
						</select>
					</label>
				{/if}
			</div>

			<div class="flex items-center gap-3 border-t border-line pt-5">
				<p class="text-xs text-muted">
					Transcripts are made on this device after you stop — nothing is sent to a speech service.
				</p>
				<button class="ml-auto btn-primary" disabled={phase === 'preparing'} onclick={begin}>
					<Circle class="size-3.5 fill-current" />
					{phase === 'preparing' ? 'Waiting for permission…' : 'Start recording'}
				</button>
			</div>
		</div>
	{:else if phase === 'countdown'}
		<div class="flex flex-col items-center gap-4 card py-16">
			<span class="text-7xl font-bold text-primary-500 tabular-nums">{count}</span>
			<p class="text-sm text-muted">Recording starts in a moment…</p>
			<button class="btn-ghost" onclick={discard}>Cancel</button>
		</div>
	{:else if phase === 'live'}
		<div class="space-y-3 card p-3">
			<video
				bind:this={previewEl}
				muted
				autoplay
				playsinline
				class="aspect-video w-full rounded-lg bg-black object-contain"
			></video>
			<div class="flex flex-wrap items-center gap-2">
				<span
					class="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm font-semibold tabular-nums {recState ===
					'paused'
						? 'bg-amber-50 text-amber-700'
						: 'bg-red-50 text-red-600'}"
				>
					<span
						class="size-2.5 rounded-full {recState === 'paused'
							? 'bg-amber-500'
							: 'animate-pulse bg-red-500'}"
					></span>
					{fmtDuration(elapsed)}
					{recState === 'paused' ? '· Paused' : ''}
				</span>
				{#if micId !== 'none'}
					<span class="flex items-center gap-1.5 text-xs text-muted" title="Mic level">
						<Mic class="size-3.5" />
						<span class="h-1.5 w-20 overflow-hidden rounded-full bg-canvas"
							><span
								class="block h-full bg-emerald-500 transition-[width] duration-75"
								style:width="{level * 100}%"
							></span></span
						>
					</span>
				{:else}
					<span class="flex items-center gap-1.5 text-xs text-muted"
						><MicOff class="size-3.5" /> No mic</span
					>
				{/if}
				<span class="flex-1"></span>
				<button class="btn-ghost h-9" onclick={discard} title="Discard"
					><Trash2 class="size-4" /> Discard</button
				>
				{#if recState === 'paused'}
					<button class="btn-outline h-9" onclick={() => recorder?.resume()}
						><Play class="size-4" /> Resume</button
					>
				{:else}
					<button class="btn-outline h-9" onclick={() => recorder?.pause()}
						><Pause class="size-4" /> Pause</button
					>
				{/if}
				<button class="btn-danger h-9" onclick={stop}
					><Square class="size-3.5 fill-current" /> Stop</button
				>
			</div>
			<p class="text-xs text-muted">
				Keep this tab open. If you’re sharing the whole desktop, this window will appear in the
				video — use the browser’s “Stop sharing” bar or come back here to stop.
			</p>
		</div>
	{:else if phase === 'saving'}
		<div class="flex flex-col items-center gap-3 card py-16">
			<p class="text-sm font-semibold">Saving your recording…</p>
			<div class="h-2 w-64 overflow-hidden rounded-full bg-canvas">
				<div class="h-full bg-primary-500 transition-[width]" style:width="{pctUploaded}%"></div>
			</div>
			<p class="text-xs text-muted tabular-nums">{pctUploaded}% uploaded</p>
		</div>
	{:else if phase === 'failed'}
		<div class="flex flex-col items-center gap-3 card px-6 py-12 text-center">
			<p class="text-sm font-semibold">Upload failed</p>
			<p class="max-w-md text-xs text-muted">{saveError}</p>
			<p class="max-w-md text-xs text-muted">
				Your recording is still in this tab — download it so it isn’t lost.
			</p>
			<div class="flex gap-2">
				<button class="btn-primary" onclick={downloadFailed}
					><Download class="size-4" /> Download recording</button
				>
				<button class="btn-ghost" onclick={() => ((failedRecording = null), discard())}
					>Discard</button
				>
			</div>
		</div>
	{/if}
</div>
