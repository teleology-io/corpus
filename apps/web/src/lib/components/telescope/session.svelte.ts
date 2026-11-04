import { goto } from '$app/navigation';
import { page } from '$app/state';
import { toast } from '#lib/stores/toast.svelte.js';
import { Recorder, type RecorderOptions, type RecorderState, type Recording } from './recorder.js';
import { PartUploader, completeDraft, createDraft, uploadThumb } from './upload.js';

export type Phase = 'setup' | 'preparing' | 'countdown' | 'live' | 'saving' | 'failed';

export const RECORD_PATH = '/telescope/record';

/**
 * The one recording in progress. Module state, so it keeps running through client-side navigation:
 * the record page and the app-wide RecordingBar are both just views of it. Closing or reloading the
 * tab still ends it, which guardUnload warns about.
 */
export const session = $state({
	phase: 'setup' as Phase,
	recState: 'idle' as RecorderState,
	count: 3,
	elapsed: 0,
	level: 0,
	uploaded: 0,
	total: 0,
	saveError: '',
	hasMic: true,
	preview: null as MediaStream | null
});

let recorder: Recorder | null = null;
let uploader: PartUploader | null = null;
let videoId: string | null = null;
let failedRecording: Recording | null = null;
let raf = 0;
let countdownTimer: ReturnType<typeof setInterval> | undefined;

function guardUnload(e: BeforeUnloadEvent) {
	if (['countdown', 'live', 'saving', 'failed'].includes(session.phase)) e.preventDefault();
}

function tick() {
	if (!recorder) return;
	session.elapsed = recorder.elapsedMs();
	session.level = recorder.level();
	raf = requestAnimationFrame(tick);
}

function goLive() {
	if (!recorder) return;
	session.phase = 'live';
	recorder.start();
	session.preview = recorder.preview;
	raf = requestAnimationFrame(tick);
}

function clear() {
	clearInterval(countdownTimer);
	cancelAnimationFrame(raf);
	recorder = null;
	uploader = null;
	videoId = null;
	failedRecording = null;
	session.preview = null;
	session.saveError = '';
	session.phase = 'setup';
}

/** Call directly from the Start click: Recorder.prepare needs its user activation. */
export async function beginRecording(options: RecorderOptions) {
	if (session.phase !== 'setup') return;
	session.phase = 'preparing';
	session.hasMic = options.micId !== null;
	session.elapsed = 0;
	session.uploaded = 0;
	session.total = 0;
	window.addEventListener('beforeunload', guardUnload);
	try {
		recorder = new Recorder({
			onstate: (s) => (session.recState = s),
			onchunk: (c) => uploader?.push(c),
			onended: () => {
				if (session.phase === 'live') void stopRecording();
				else if (session.phase === 'countdown') void discardRecording();
			}
		});
		await recorder.prepare(options);
		const draft = await createDraft(recorder.mime);
		videoId = draft.id;
		uploader = new PartUploader(draft.id, (u, t) => ((session.uploaded = u), (session.total = t)));
	} catch (e) {
		recorder?.discard();
		clear();
		toast('Could not start recording', { tone: 'error', body: (e as Error).message });
		return;
	}
	session.phase = 'countdown';
	session.count = 3;
	countdownTimer = setInterval(() => {
		session.count -= 1;
		if (session.count > 0) return;
		clearInterval(countdownTimer);
		goLive();
	}, 1000);
}

export const pauseRecording = () => recorder?.pause();
export const resumeRecording = () => recorder?.resume();

export async function stopRecording() {
	if (session.phase !== 'live' || !recorder || !uploader || !videoId) return;
	const id = videoId;
	cancelAnimationFrame(raf);
	session.phase = 'saving';
	const recording = await recorder.stop();
	recorder = null;
	session.preview = null;
	if (!recording.blob.size) {
		await discardRecording();
		toast('Nothing was recorded', { tone: 'error' });
		return;
	}
	try {
		const parts = await uploader.finish();
		await completeDraft(id, {
			parts,
			durationMs: recording.durationMs,
			width: recording.width,
			height: recording.height
		});
		if (recording.thumb) await uploadThumb(id, recording.thumb).catch(() => {});
		// Loaded on demand to keep the speech code out of the app layout's bundle. The job is module
		// state, so it continues on whichever page comes next.
		void import('./jobs.svelte.js')
			.then((jobs) => jobs.startTranscription(id, recording.blob))
			.catch(() => {});
		clear();
		// Only the record page moves on by itself; elsewhere the user may still be mid-demo.
		if (page.url.pathname === RECORD_PATH) await goto(`/telescope/${id}`);
		else toast('Recording saved', { tone: 'success', href: `/telescope/${id}` });
	} catch (e) {
		failedRecording = recording;
		session.saveError = (e as Error).message;
		session.phase = 'failed';
	}
}

export async function discardRecording() {
	const id = videoId;
	recorder?.discard();
	clear();
	if (id) await fetch(`/api/telescope/${id}`, { method: 'DELETE' }).catch(() => {});
}

export function downloadFailedRecording() {
	if (!failedRecording) return;
	const a = document.createElement('a');
	a.href = URL.createObjectURL(failedRecording.blob);
	a.download = `recording.${failedRecording.mime.includes('mp4') ? 'mp4' : 'webm'}`;
	a.click();
	setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
