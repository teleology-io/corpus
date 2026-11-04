<script lang="ts">
	import { onMount } from 'svelte';
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
		canCaptureTab,
		canRecordScreen,
		listDevices,
		systemAudioLikely,
		type Mode,
		type Surface
	} from '#lib/components/telescope/recorder.js';
	import {
		beginRecording,
		discardRecording,
		downloadFailedRecording,
		pauseRecording,
		resumeRecording,
		session,
		stopRecording
	} from '#lib/components/telescope/session.svelte.js';
	import { fmtDuration } from '#lib/telescope.js';

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

	let previewEl: HTMLVideoElement | undefined = $state();

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
		return () => navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices);
	});

	async function begin() {
		localStorage.setItem(PREFS, JSON.stringify({ mode, surface, micId, cameraId }));
		await beginRecording({
			mode,
			surface,
			micId: micId === 'none' ? null : micId || '',
			cameraId: cameraId || null
		});
		// Permission granted → labels are available now.
		void refreshDevices();
	}

	// The preview element mounts once phase flips to 'live', or on coming back to this page.
	$effect(() => {
		if (previewEl && session.preview) previewEl.srcObject = session.preview;
	});

	const pctUploaded = $derived(
		session.total ? Math.round((session.uploaded / session.total) * 100) : 0
	);
</script>

<svelte:head><title>New recording · Telescope · Corpus</title></svelte:head>

<div class="mx-auto max-w-3xl space-y-6 p-4 lg:p-8">
	<a href="/telescope" class="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
		><ArrowLeft class="size-4" /> All recordings</a
	>

	{#if session.phase === 'setup' || session.phase === 'preparing'}
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
				<button
					class="ml-auto btn-primary"
					disabled={session.phase === 'preparing'}
					onclick={begin}
				>
					<Circle class="size-3.5 fill-current" />
					{session.phase === 'preparing' ? 'Waiting for permission…' : 'Start recording'}
				</button>
			</div>
		</div>
	{:else if session.phase === 'countdown'}
		<div class="flex flex-col items-center gap-4 card py-16">
			<span class="text-7xl font-bold text-primary-500 tabular-nums">{session.count}</span>
			<p class="text-sm text-muted">Recording starts in a moment…</p>
			<button class="btn-ghost" onclick={discardRecording}>Cancel</button>
		</div>
	{:else if session.phase === 'live'}
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
					class="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm font-semibold tabular-nums {session.recState ===
					'paused'
						? 'bg-amber-50 text-amber-700'
						: 'bg-red-50 text-red-600'}"
				>
					<span
						class="size-2.5 rounded-full {session.recState === 'paused'
							? 'bg-amber-500'
							: 'animate-pulse bg-red-500'}"
					></span>
					{fmtDuration(session.elapsed)}
					{session.recState === 'paused' ? '· Paused' : ''}
				</span>
				{#if session.hasMic}
					<span class="flex items-center gap-1.5 text-xs text-muted" title="Mic level">
						<Mic class="size-3.5" />
						<span class="h-1.5 w-20 overflow-hidden rounded-full bg-canvas"
							><span
								class="block h-full bg-emerald-500 transition-[width] duration-75"
								style:width="{session.level * 100}%"
							></span></span
						>
					</span>
				{:else}
					<span class="flex items-center gap-1.5 text-xs text-muted"
						><MicOff class="size-3.5" /> No mic</span
					>
				{/if}
				<span class="flex-1"></span>
				<button class="btn-ghost h-9" onclick={discardRecording} title="Discard"
					><Trash2 class="size-4" /> Discard</button
				>
				{#if session.recState === 'paused'}
					<button class="btn-outline h-9" onclick={resumeRecording}
						><Play class="size-4" /> Resume</button
					>
				{:else}
					<button class="btn-outline h-9" onclick={pauseRecording}
						><Pause class="size-4" /> Pause</button
					>
				{/if}
				<button class="btn-danger h-9" onclick={stopRecording}
					><Square class="size-3.5 fill-current" /> Stop</button
				>
			</div>
			<p class="text-xs text-muted">
				You can use the rest of Corpus while recording, with controls in the bar at the top. Don’t
				close or reload this tab. If you’re sharing the whole desktop or this window, those controls
				will appear in the video.
			</p>
		</div>
	{:else if session.phase === 'saving'}
		<div class="flex flex-col items-center gap-3 card py-16">
			<p class="text-sm font-semibold">Saving your recording…</p>
			<div class="h-2 w-64 overflow-hidden rounded-full bg-canvas">
				<div class="h-full bg-primary-500 transition-[width]" style:width="{pctUploaded}%"></div>
			</div>
			<p class="text-xs text-muted tabular-nums">{pctUploaded}% uploaded</p>
		</div>
	{:else if session.phase === 'failed'}
		<div class="flex flex-col items-center gap-3 card px-6 py-12 text-center">
			<p class="text-sm font-semibold">Upload failed</p>
			<p class="max-w-md text-xs text-muted">{session.saveError}</p>
			<p class="max-w-md text-xs text-muted">
				Your recording is still in this tab — download it so it isn’t lost.
			</p>
			<div class="flex gap-2">
				<button class="btn-primary" onclick={downloadFailedRecording}
					><Download class="size-4" /> Download recording</button
				>
				<button class="btn-ghost" onclick={discardRecording}>Discard</button>
			</div>
		</div>
	{/if}
</div>
