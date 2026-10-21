import { transcribe, type TranscribeProgress } from './transcribe.js';

export interface TranscriptJob {
	progress: TranscribeProgress;
	status: 'running' | 'done' | 'failed';
	error?: string;
}

/**
 * Transcriptions in flight, keyed by video id. Module state, so a job started on the recorder
 * page keeps running (and stays visible) after client-side navigation to the video page.
 * Closing the tab drops it; the video stays "pending" and its owner can transcribe again.
 */
export const jobs = $state<Record<string, TranscriptJob>>({});

async function save(id: string, body: unknown) {
	const res = await fetch(`/api/telescope/${id}/transcript`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	if (!res.ok) throw new Error('Could not save transcript');
}

/** Transcribes `media` (or downloads the stored video first) and saves the result. */
export async function startTranscription(id: string, media?: Blob) {
	if (jobs[id]?.status === 'running') return;
	jobs[id] = { status: 'running', progress: { phase: 'decoding', fraction: 0 } };
	try {
		if (!media) {
			const res = await fetch(`/api/telescope/${id}/media`);
			if (!res.ok) throw new Error('Could not download the video');
			media = await res.blob();
		}
		const segments = await transcribe(media, (p) => (jobs[id]!.progress = p));
		await save(id, { segments });
		jobs[id]!.status = 'done';
	} catch (e) {
		const message = (e as Error).message || 'Transcription failed';
		jobs[id] = { ...jobs[id]!, status: 'failed', error: message };
		await save(id, { failed: true }).catch(() => {});
	}
}

export function describeJob(job: TranscriptJob) {
	const pct = Math.round(job.progress.fraction * 100);
	if (job.progress.phase === 'model') return `Downloading speech model… ${pct}%`;
	if (job.progress.phase === 'decoding') return 'Preparing audio…';
	return `Transcribing… ${pct}%`;
}
