import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Model, KaldiRecognizer } from 'vosk-browser';

/** Served from static/; fetched by `make models` (see scripts/fetch-vosk-model.mjs). */
export const MODEL_PATH = '/models/vosk-model-small-en-us-0.15.tar.gz';

// The model (~40MB, decoded into a WASM worker) is loaded once per tab and reused.
let modelPromise: Promise<Model> | null = null;

function loadModel() {
	modelPromise ??= (async () => {
		// Vosk runs in a blob worker, so the URL must be absolute. Probe first: a missing
		// model makes the worker error without ever resolving createModel.
		const url = new URL(MODEL_PATH, location.origin).href;
		const probe = await fetch(url, { method: 'HEAD' });
		if (!probe.ok) throw new Error('Speech model not installed — run `make models`');
		const { createModel } = await import('vosk-browser');
		return createModel(url);
	})().catch((e) => {
		modelPromise = null;
		throw e;
	});
	return modelPromise;
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
	/** 0..1 input level, for the meter */
	onlevel?: (level: number) => void;
	onerror: (message: string) => void;
}

/** One mic → Vosk streaming session. Call start() once, stop() to flush and release. */
export class Dictation {
	private stream: MediaStream | null = null;
	private ctx: AudioContext | null = null;
	private recognizer: KaldiRecognizer | null = null;
	private flushed: (() => void) | null = null;
	private cancelled = false;

	constructor(private h: DictationHandlers) {}

	async start() {
		this.h.onstatus('loading');
		try {
			// Ask for the mic first so the permission prompt isn't delayed by the model download.
			this.stream = await navigator.mediaDevices.getUserMedia({
				audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
			});
			const model = await loadModel();
			if (this.cancelled) return this.release();

			this.ctx = new AudioContext();
			const blob = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
			await this.ctx.audioWorklet.addModule(blob);
			URL.revokeObjectURL(blob);
			if (this.cancelled) return this.release();

			const rec = new model.KaldiRecognizer(this.ctx.sampleRate);
			this.recognizer = rec;
			rec.on('partialresult', (m) => {
				if (m.event === 'partialresult') this.h.onpartial(m.result.partial);
			});
			rec.on('result', (m) => {
				if (m.event !== 'result') return;
				if (m.result.text) this.h.onresult(m.result.text);
				this.h.onpartial('');
				this.flushed?.();
			});
			rec.on('error', (m) => {
				if (m.event === 'error') this.h.onerror(m.error);
			});

			const source = this.ctx.createMediaStreamSource(this.stream);
			const tap = new AudioWorkletNode(this.ctx, 'dictation-tap');
			const sampleRate = this.ctx.sampleRate;
			tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
				rec.acceptWaveformFloat(e.data, sampleRate);
				if (this.h.onlevel) {
					let sum = 0;
					for (const s of e.data) sum += s * s;
					this.h.onlevel(Math.min(1, Math.sqrt(sum / e.data.length) * 6));
				}
			};
			source.connect(tap);
			this.h.onstatus('listening');
		} catch (e) {
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
		if (!this.recognizer) return this.release();
		this.h.onstatus('stopping');
		// Stop feeding audio, then ask Vosk for whatever's left in its buffer.
		this.stream?.getTracks().forEach((t) => t.stop());
		await this.ctx?.close();
		this.ctx = null;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, 1500);
			this.flushed = () => (clearTimeout(timer), resolve());
			this.recognizer!.retrieveFinalResult();
		});
		this.release();
	}

	private release() {
		this.stream?.getTracks().forEach((t) => t.stop());
		void this.ctx?.close();
		this.recognizer?.remove();
		this.stream = null;
		this.ctx = null;
		this.recognizer = null;
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
