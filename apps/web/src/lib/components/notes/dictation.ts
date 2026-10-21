import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
/** Keep in sync with VERSION in scripts/fetch-asr-model.mjs (`make models`). */
const ASR_VERSION = 'v1.13.7';
const ASR_BASE = `/sherpa/${ASR_VERSION}/`;

type WorkerMsg =
	| { type: 'progress'; loaded: number; total: number }
	| { type: 'ready' | 'flushed' | 'ack' }
	| { type: 'partial'; text: string }
	| { type: 'final'; text: string; start: number; end: number }
	| { type: 'error'; message: string };
export type AsrMessage = WorkerMsg;

/**
 * Spins up a sherpa-onnx streaming Zipformer worker (static/asr-worker.js) and resolves once
 * the model is loaded. Single-threaded WASM, so no cross-origin isolation headers are needed;
 * the model files come from the Cache API after the first download.
 */
export function createAsrWorker(onprogress?: (fraction: number) => void) {
	return new Promise<Worker>((resolve, reject) => {
		const worker = new Worker('/asr-worker.js');
		const onInit = ({ data }: MessageEvent<WorkerMsg>) => {
			if (data.type === 'progress' && data.total) onprogress?.(data.loaded / data.total);
			if (data.type === 'ready') {
				worker.removeEventListener('message', onInit);
				resolve(worker);
			}
			if (data.type === 'error') {
				worker.terminate();
				reject(new Error(data.message));
			}
		};
		worker.addEventListener('message', onInit);
		worker.onerror = (e) => (worker.terminate(), reject(new Error(e.message)));
		worker.postMessage({ type: 'init', base: ASR_BASE });
	});
}

/** Dictation shares one worker per tab. */
let engine: Promise<Worker> | null = null;
let progressListener: ((fraction: number) => void) | null = null;

function loadEngine() {
	engine ??= createAsrWorker((f) => progressListener?.(f)).catch((e) => {
		engine = null;
		throw e;
	});
	return engine;
}

// Batches 128-frame render quanta into ~4k-sample chunks before posting to the main thread.
const WORKLET = `
class Tap extends AudioWorkletProcessor {
	buf = new Float32Array(4096);
	n = 0;
	process([input]) {
		const ch = input[0];
		if (ch) {
			for (let i = 0; i < ch.length; i++) {
				this.buf[this.n++] = ch[i];
				if (this.n === this.buf.length) {
					this.port.postMessage(this.buf.slice());
					this.n = 0;
				}
			}
		}
		return true;
	}
}
registerProcessor('dictation-tap', Tap);
`;

export type DictationStatus = 'idle' | 'loading' | 'listening' | 'stopping';

export interface DictationHandlers {
	onstatus: (s: DictationStatus) => void;
	onpartial: (text: string) => void;
	onresult: (text: string) => void;
	/** 0..1 model download progress (first use only) */
	onprogress?: (fraction: number) => void;
	/** 0..1 input level, for the meter */
	onlevel?: (level: number) => void;
	onerror: (message: string) => void;
}

/** The model emits upper-case text; normalise to sentence-ready lower case. */
const tidy = (text: string) => text.toLowerCase().replace(/\bi\b/g, 'I');

/** One mic → sherpa-onnx streaming session. Call start() once, stop() to flush and release. */
export class Dictation {
	private stream: MediaStream | null = null;
	private ctx: AudioContext | null = null;
	private worker: Worker | null = null;
	private flushed: (() => void) | null = null;
	private cancelled = false;

	constructor(private h: DictationHandlers) {}

	private onMessage = ({ data }: MessageEvent<WorkerMsg>) => {
		if (data.type === 'partial') this.h.onpartial(tidy(data.text));
		else if (data.type === 'final') {
			this.h.onresult(tidy(data.text));
			this.h.onpartial('');
		} else if (data.type === 'flushed') this.flushed?.();
		else if (data.type === 'error') {
			// A WASM abort leaves the engine unusable; drop it so the next start reloads it.
			this.worker?.terminate();
			engine = null;
			this.h.onerror(data.message);
			// Mid-stop: let stop() finish releasing; mid-listen: release now.
			if (this.flushed) this.flushed();
			else this.release();
		}
	};

	async start() {
		this.h.onstatus('loading');
		try {
			// Ask for the mic first so the permission prompt isn't delayed by the model download.
			this.stream = await navigator.mediaDevices.getUserMedia({
				audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
			});
			progressListener = this.h.onprogress ?? null;
			const worker = await loadEngine();
			progressListener = null;
			if (this.cancelled) return this.release();

			this.ctx = new AudioContext();
			const blob = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
			await this.ctx.audioWorklet.addModule(blob);
			URL.revokeObjectURL(blob);
			if (this.cancelled) return this.release();

			this.worker = worker;
			worker.addEventListener('message', this.onMessage);
			const source = this.ctx.createMediaStreamSource(this.stream);
			const tap = new AudioWorkletNode(this.ctx, 'dictation-tap');
			const sampleRate = this.ctx.sampleRate;
			tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
				if (this.h.onlevel) {
					let sum = 0;
					for (const s of e.data) sum += s * s;
					this.h.onlevel(Math.min(1, Math.sqrt(sum / e.data.length) * 6));
				}
				// sherpa-onnx resamples to 16kHz itself.
				worker.postMessage({ type: 'audio', samples: e.data, sampleRate }, [e.data.buffer]);
			};
			source.connect(tap);
			this.h.onstatus('listening');
		} catch (e) {
			progressListener = null;
			this.release();
			const err = e as Error;
			this.h.onerror(
				err.name === 'NotAllowedError'
					? 'Microphone access was blocked'
					: err.message || 'Could not start dictation'
			);
		}
	}

	async stop() {
		this.cancelled = true;
		if (!this.worker) return this.release();
		this.h.onstatus('stopping');
		// Stop feeding audio, then have the recognizer finish the utterance in flight.
		this.stream?.getTracks().forEach((t) => t.stop());
		await this.ctx?.close();
		this.ctx = null;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, 3000);
			this.flushed = () => (clearTimeout(timer), resolve());
			this.worker!.postMessage({ type: 'flush' });
		});
		this.release();
	}

	private release() {
		this.stream?.getTracks().forEach((t) => t.stop());
		void this.ctx?.close();
		this.worker?.removeEventListener('message', this.onMessage);
		this.stream = null;
		this.ctx = null;
		this.worker = null;
		this.flushed = null;
		this.h.onpartial('');
		this.h.onlevel?.(0);
		this.h.onstatus('idle');
	}
}

const previewKey = new PluginKey<string>('dictationPreview');

/**
 * Shows the in-flight (partial) transcript as a ghost widget at the caret. Only final
 * results are written to the doc, so collaborators never see half-recognized words churn.
 */
export const DictationPreview = Extension.create({
	name: 'dictationPreview',
	addProseMirrorPlugins() {
		return [
			new Plugin<string>({
				key: previewKey,
				state: {
					init: () => '',
					apply: (tr, prev) => tr.getMeta(previewKey) ?? prev
				},
				props: {
					decorations(state) {
						const text = previewKey.getState(state);
						if (!text) return null;
						return DecorationSet.create(state.doc, [
							Decoration.widget(
								state.selection.head,
								() => {
									const el = document.createElement('span');
									el.className = 'dictation-partial';
									el.textContent = text;
									return el;
								},
								{ key: text, side: 1 }
							)
						]);
					}
				}
			})
		];
	}
});

export function setPartial(editor: Editor, text: string) {
	if (editor.isDestroyed) return;
	editor.view.dispatch(editor.state.tr.setMeta(previewKey, text).setMeta('addToHistory', false));
}

/** Inserts a final phrase at the caret with sentence-aware spacing and capitalization. */
export function insertTranscript(editor: Editor, text: string) {
	if (editor.isDestroyed || !text) return;
	const { $head } = editor.state.selection;
	const before = $head.parent.textBetween(0, $head.parentOffset);
	const needsSpace = before.length > 0 && !/\s$/.test(before);
	const sentenceStart = /(^|[.!?])$/.test(before.trimEnd());
	const phrase = sentenceStart ? text[0].toUpperCase() + text.slice(1) : text;
	editor.commands.insertContent((needsSpace ? ' ' : '') + phrase);
}
