import { createAsrWorker, type AsrMessage } from '../notes/dictation.js';
import type { TranscriptSegment } from '#lib/telescope.js';

const RATE = 16000;
/** One second per message; the worker acks each so we never queue the whole file at once. */
const CHUNK = RATE;

export interface TranscribeProgress {
	phase: 'model' | 'decoding' | 'transcribing';
	/** 0..1 within the phase */
	fraction: number;
}

/** The model emits upper-case text; normalise to sentence case. */
function tidy(text: string) {
	const t = text.toLowerCase().replace(/\bi\b/g, 'I').trim();
	return t ? t[0]!.toUpperCase() + t.slice(1) : t;
}

/** Decodes a recording's audio track to mono 16 kHz PCM (decodeAudioData resamples for us). */
async function decodeMono16k(media: Blob): Promise<Float32Array | null> {
	const ctx = new OfflineAudioContext(1, 1, RATE);
	let buf: AudioBuffer;
	try {
		buf = await ctx.decodeAudioData(await media.arrayBuffer());
	} catch {
		// No audio track (recorded without mic/system audio) or an undecodable container.
		return null;
	}
	if (buf.numberOfChannels === 1) return buf.getChannelData(0);
	const out = new Float32Array(buf.length);
	for (let c = 0; c < buf.numberOfChannels; c++) {
		const ch = buf.getChannelData(c);
		for (let i = 0; i < ch.length; i++) out[i]! += ch[i]! / buf.numberOfChannels;
	}
	return out;
}

/**
 * Transcribes a finished recording entirely in the browser with the same sherpa-onnx model
 * dictation uses (own worker, so it never fights a live dictation session). Feeds the audio
 * faster than real time and collects timestamped segments.
 */
export async function transcribe(
	media: Blob,
	onprogress: (p: TranscribeProgress) => void,
	signal?: AbortSignal
): Promise<TranscriptSegment[]> {
	onprogress({ phase: 'decoding', fraction: 0 });
	const pcm = await decodeMono16k(media);
	if (!pcm || !pcm.length) return [];
	signal?.throwIfAborted();

	onprogress({ phase: 'model', fraction: 0 });
	const worker = await createAsrWorker((fraction) => onprogress({ phase: 'model', fraction }));
	const segments: TranscriptSegment[] = [];
	let failure: Error | null = null;
	let wake: (() => void) | null = null;

	worker.onmessage = ({ data }: MessageEvent<AsrMessage>) => {
		if (data.type === 'final') {
			const text = tidy(data.text);
			if (text) segments.push({ start: data.start, end: data.end, text });
		} else if (data.type === 'error') failure = new Error(data.message);
		if (data.type === 'ack' || data.type === 'flushed' || data.type === 'error') wake?.();
	};
	const waitFor = () => new Promise<void>((r) => (wake = r));

	try {
		worker.postMessage({ type: 'reset' });
		for (let at = 0; at < pcm.length; at += CHUNK) {
			signal?.throwIfAborted();
			const samples = pcm.slice(at, at + CHUNK);
			const acked = waitFor();
			worker.postMessage({ type: 'audio', samples, sampleRate: RATE, ack: true }, [samples.buffer]);
			await acked;
			if (failure) throw failure;
			onprogress({ phase: 'transcribing', fraction: Math.min(1, (at + CHUNK) / pcm.length) });
		}
		const flushed = waitFor();
		worker.postMessage({ type: 'flush' });
		await flushed;
		if (failure) throw failure;
		return segments;
	} finally {
		worker.terminate();
	}
}
