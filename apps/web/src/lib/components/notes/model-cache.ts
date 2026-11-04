// Downloads model files into the Cache API ahead of use. Files stream straight to disk, so this
// needs no worker, no GPU, and no memory for the model. Keep this module free of dependencies:
// the speech and rewrite loaders both wait on it.

export interface ModelDownload {
	name: string;
	/** The Cache API bucket the model's real loader reads from. */
	cacheName: string;
	/** Must be the exact URLs the loader looks up, or it downloads them again. */
	urls: string[];
	/** Rough total, to skip the download when the browser has no room for it. */
	bytes: number;
}

interface Active {
	controller: AbortController;
	listeners: Set<(fraction: number) => void>;
	promise: Promise<void>;
}

/** Below this a file finishes too fast for progress to mean anything. */
const REPORT_ABOVE_BYTES = 1_000_000;

const active = new Map<string, Active>();

async function fetchInto(cache: Cache, url: string, entry: Active) {
	const { signal } = entry.controller;
	const res = await fetch(url, { signal, priority: 'low' } as RequestInit);
	if (!res.ok || !res.body) throw new Error(`${url} returned ${res.status}`);
	const total = Number(res.headers.get('content-length')) || 0;
	let loaded = 0;
	let percent = -1;
	const counted = res.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				loaded += chunk.length;
				const next = Math.floor(Math.min(1, loaded / total) * 100);
				if (total > REPORT_ABOVE_BYTES && next !== percent) {
					percent = next;
					for (const listener of entry.listeners) listener(next / 100);
				}
				controller.enqueue(chunk);
			}
		})
	);
	// Stored only once the whole body has arrived, so an interrupted download leaves nothing behind.
	await cache.put(url, new Response(counted, { status: res.status, headers: res.headers }));
}

async function hasRoom(bytes: number) {
	try {
		const { quota, usage } = await navigator.storage.estimate();
		return quota === undefined || usage === undefined || quota - usage > bytes;
	} catch {
		return true;
	}
}

async function run(model: ModelDownload, entry: Active) {
	const cache = await caches.open(model.cacheName);
	const hits = await Promise.all(model.urls.map((url) => cache.match(url)));
	const missing = model.urls.filter((_, i) => !hits[i]);
	if (!missing.length || !(await hasRoom(model.bytes))) return;
	for (const url of missing) await fetchInto(cache, url, entry);
}

/** Starts a background download unless it's already running. Failures only log: use will retry. */
export function downloadModel(model: ModelDownload) {
	const running = active.get(model.name);
	if (running) return running.promise;
	if (typeof caches === 'undefined') return Promise.resolve();

	const entry: Active = {
		controller: new AbortController(),
		listeners: new Set(),
		promise: Promise.resolve()
	};
	const { signal } = entry.controller;
	// One tab downloads at a time. The others find the files cached when their turn comes.
	const work = navigator.locks
		? navigator.locks.request(`corpus-model:${model.name}`, { signal }, () => run(model, entry))
		: run(model, entry);
	entry.promise = work
		.catch((e: Error) => {
			if (e.name !== 'AbortError') console.warn(`Model download failed: ${model.name}`, e);
		})
		.finally(() => active.delete(model.name));
	active.set(model.name, entry);
	return entry.promise;
}

/** Resolves when any running download of this model ends, so loaders don't fetch it twice. */
export async function waitForModel(name: string, onprogress?: (fraction: number) => void) {
	const entry = active.get(name);
	if (!entry) return;
	if (onprogress) entry.listeners.add(onprogress);
	await entry.promise;
	if (onprogress) entry.listeners.delete(onprogress);
}

export function cancelModelDownload(name: string) {
	active.get(name)?.controller.abort();
}
