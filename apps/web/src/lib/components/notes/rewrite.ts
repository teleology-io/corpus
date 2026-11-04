// Editor-agnostic on-device text generation (worker lifecycle). The editor bits live in
// rewrite-editor.ts.
import { cancelModelDownload, waitForModel, type ModelDownload } from './model-cache.js';
import type { ChatMessage } from './rewrite-prompts.js';

export const REWRITE_MODEL = 'LiquidAI/LFM2.5-1.2B-Instruct-ONNX';
/** Pinned so a model update upstream can't change behaviour or trigger a new download. */
const REWRITE_REVISION = '10f72e70abf67ac0fd7ebf15bc5854726891d864';
/** A dedicated Cache API bucket, so removing the model can't touch anything else. */
const REWRITE_CACHE = 'corpus-rewrite-model';
const REWRITE_BASE = `https://huggingface.co/${REWRITE_MODEL}/resolve/${REWRITE_REVISION}/`;

/** The files and URLs Transformers.js 4.3.2 looks up for this model at dtype q4. */
export const REWRITE_DOWNLOAD: ModelDownload = {
	name: 'rewrite',
	cacheName: REWRITE_CACHE,
	urls: [
		'config.json',
		'generation_config.json',
		'tokenizer.json',
		'tokenizer_config.json',
		'chat_template.jinja',
		'onnx/model_q4.onnx',
		'onnx/model_q4.onnx_data'
	].map((file) => REWRITE_BASE + file),
	bytes: 860_000_000
};
/** The model holds over 1 GB of GPU memory, so release it when not in use. */
const IDLE_MS = 5 * 60 * 1000;

export type WorkerInbound =
	| { type: 'init'; model: string; revision: string; cacheKey: string }
	| { type: 'generate'; id: number; messages: ChatMessage[]; maxNewTokens: number }
	| { type: 'cancel'; id: number };

export type WorkerOutbound =
	| { type: 'progress'; fraction: number }
	| { type: 'ready' }
	| { type: 'token'; id: number; text: string }
	| { type: 'done'; id: number }
	| { type: 'error'; id?: number; message: string };

export interface RewriteHandlers {
	/** 0..1 model download progress (first use only) */
	onprogress?: (fraction: number) => void;
	ontoken: (text: string) => void;
	ondone: () => void;
	onerror: (message: string) => void;
}

let supported: Promise<boolean> | null = null;

/** WebGPU needs a secure context, so this is also false over plain HTTP on the LAN. */
export function rewriteSupported() {
	supported ??= (async () => {
		try {
			if (!globalThis.isSecureContext) return false;
			const { gpu } = navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } };
			return !!(await gpu?.requestAdapter());
		} catch {
			return false;
		}
	})();
	return supported;
}

/** One worker per tab, loaded on first use and dropped when idle. */
let engine: Promise<Worker> | null = null;
let liveWorker: Worker | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let progressListener: ((fraction: number) => void) | null = null;
let nextId = 1;

function dropEngine() {
	clearTimeout(idleTimer);
	liveWorker?.terminate();
	liveWorker = null;
	engine = null;
}

function loadEngine() {
	if (engine) return engine;
	// A background download may be running, so join it instead of fetching the model twice.
	const load: Promise<Worker> = waitForModel(REWRITE_DOWNLOAD.name, (f) =>
		progressListener?.(f)
	).then(() =>
		// Cancelled while waiting: nobody is left to use a worker.
		engine === load ? spawnWorker() : new Promise<Worker>(() => {})
	);
	engine = load;
	return load;
}

function spawnWorker() {
	return new Promise<Worker>((resolve, reject) => {
		const worker = new Worker(new URL('./rewrite.worker.ts', import.meta.url), { type: 'module' });
		liveWorker = worker;
		const fail = (message: string) => {
			worker.removeEventListener('message', onInit);
			dropEngine();
			reject(new Error(message));
		};
		const onError = (e: ErrorEvent) => fail(e.message || 'Could not start the model');
		const onInit = ({ data }: MessageEvent<WorkerOutbound>) => {
			if (data.type === 'progress') progressListener?.(data.fraction);
			if (data.type === 'error') fail(data.message);
			if (data.type === 'ready') {
				worker.removeEventListener('message', onInit);
				worker.removeEventListener('error', onError);
				resolve(worker);
			}
		};
		worker.addEventListener('message', onInit);
		worker.addEventListener('error', onError);
		worker.postMessage({
			type: 'init',
			model: REWRITE_MODEL,
			revision: REWRITE_REVISION,
			cacheKey: REWRITE_CACHE
		} satisfies WorkerInbound);
	});
}

function armIdle() {
	clearTimeout(idleTimer);
	idleTimer = setTimeout(dropEngine, IDLE_MS);
}

/** Starts one generation. Handlers stop firing after cancel(). */
export function startRewrite(
	messages: ChatMessage[],
	maxNewTokens: number,
	h: RewriteHandlers
): { cancel: () => void } {
	clearTimeout(idleTimer);
	const id = nextId++;
	let stopped = false;
	let worker: Worker | null = null;

	const detach = () => {
		stopped = true;
		worker?.removeEventListener('message', onMessage);
		worker?.removeEventListener('error', onCrash);
	};
	// A failed generation may have lost the GPU device, so the next run loads a fresh worker.
	const fail = (message: string) => {
		detach();
		dropEngine();
		h.onerror(message);
	};
	const onCrash = (e: ErrorEvent) => fail(e.message || 'The model stopped unexpectedly');
	const onMessage = ({ data }: MessageEvent<WorkerOutbound>) => {
		if (data.type === 'error') {
			if (data.id === undefined || data.id === id) fail(data.message);
		} else if (data.type === 'token' && data.id === id) h.ontoken(data.text);
		else if (data.type === 'done' && data.id === id) {
			detach();
			armIdle();
			h.ondone();
		}
	};

	progressListener = h.onprogress ?? null;
	loadEngine().then(
		(w) => {
			if (stopped) return;
			progressListener = null;
			worker = w;
			w.addEventListener('message', onMessage);
			w.addEventListener('error', onCrash);
			w.postMessage({ type: 'generate', id, messages, maxNewTokens } satisfies WorkerInbound);
		},
		(e: Error) => {
			if (!stopped) fail(e.message);
		}
	);

	return {
		cancel() {
			if (stopped) return;
			const running = worker;
			detach();
			progressListener = null;
			if (running) {
				running.postMessage({ type: 'cancel', id } satisfies WorkerInbound);
				armIdle();
			} else {
				// Still loading: stop the worker. A background download carries on, as it's wanted anyway.
				dropEngine();
			}
		}
	};
}

export const stopRewriteDownload = () => cancelModelDownload(REWRITE_DOWNLOAD.name);

export async function rewriteModelStored() {
	return typeof caches !== 'undefined' && caches.has(REWRITE_CACHE);
}

/** Frees the disk space. */
export async function removeRewriteModel() {
	stopRewriteDownload();
	dropEngine();
	await caches.delete(REWRITE_CACHE);
}
