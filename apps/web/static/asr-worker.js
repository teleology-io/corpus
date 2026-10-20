// Note dictation: sherpa-onnx streaming Zipformer (single-threaded WASM) off the main thread.
// Classic worker because the emscripten glue is loaded with importScripts.
//
// in:  { type: 'init', base }            base = '/sherpa/<version>/'
//      { type: 'audio', samples, sampleRate }
//      { type: 'flush' }                  finish the current utterance
// out: { type: 'progress', loaded, total } | { type: 'ready' } | { type: 'error', message }
//      { type: 'partial', text } | { type: 'final', text } | { type: 'flushed' }

const DATA = 'sherpa-onnx-wasm-main-asr.data';
const WASM = 'sherpa-onnx-wasm-main-asr.wasm';

let recognizer = null;
let stream = null;
let last = '';
// sherpa-onnx aborts if the sample rate changes mid-stream, so padding must match the input.
let sampleRate = 16000;

/** Fetches through the Cache API so the ~190MB model survives reloads, reporting progress. */
async function cachedFetch(url, cacheName, onProgress) {
	const cache = await caches.open(cacheName).catch(() => null);
	const hit = await cache?.match(url);
	if (hit) return hit.arrayBuffer();
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Speech model missing (${res.status}) — run \`make models\``);
	const total = Number(res.headers.get('content-length')) || 0;
	const reader = res.body.getReader();
	const chunks = [];
	let loaded = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		loaded += value.length;
		onProgress?.(loaded, total);
	}
	const buf = new Uint8Array(loaded);
	let at = 0;
	for (const c of chunks) {
		buf.set(c, at);
		at += c.length;
	}
	await cache?.put(url, new Response(buf, { headers: res.headers })).catch(() => {});
	return buf.buffer;
}

async function init(base) {
	const cacheName = `corpus-asr-${base}`;
	let [wasmBinary, data] = await Promise.all([
		cachedFetch(base + WASM, cacheName),
		cachedFetch(base + DATA, cacheName, (loaded, total) =>
			postMessage({ type: 'progress', loaded, total })
		)
	]);
	await new Promise((resolve, reject) => {
		self.Module = {
			wasmBinary,
			locateFile: (path) => base + path,
			// Hand the buffers over once; emscripten copies them into its heap, so don't keep
			// a second ~200MB reference around.
			getPreloadedPackage: () => {
				const d = data;
				data = null;
				return d;
			},
			print: () => {},
			printErr: () => {},
			onAbort: (what) => reject(new Error(`Speech engine failed: ${what}`)),
			onRuntimeInitialized: () => {
				self.Module.wasmBinary = wasmBinary = null;
				recognizer = self.createOnlineRecognizer(self.Module, config());
				stream = recognizer.createStream();
				resolve();
			}
		};
		importScripts(base + 'sherpa-onnx-asr.js', base + 'sherpa-onnx-wasm-main-asr.js');
	});
}

/** The build's default config (model files baked into the .data package), minus debug logging. */
function config() {
	return {
		featConfig: { sampleRate: 16000, featureDim: 80 },
		modelConfig: {
			transducer: { encoder: './encoder.onnx', decoder: './decoder.onnx', joiner: './joiner.onnx' },
			paraformer: { encoder: '', decoder: '' },
			zipformer2Ctc: { model: '' },
			nemoCtc: { model: '' },
			toneCtc: { model: '' },
			tokens: './tokens.txt',
			numThreads: 1,
			provider: 'cpu',
			debug: 0,
			modelType: '',
			modelingUnit: 'cjkchar',
			bpeVocab: ''
		},
		decodingMethod: 'greedy_search',
		maxActivePaths: 4,
		enableEndpoint: 1,
		// Close an utterance after ~0.8s of silence once something was said.
		rule1MinTrailingSilence: 2.4,
		rule2MinTrailingSilence: 0.8,
		rule3MinUtteranceLength: 20,
		hotwordsFile: '',
		hotwordsScore: 1.5,
		ctcFstDecoderConfig: { graph: '', maxActive: 3000 },
		ruleFsts: '',
		ruleFars: ''
	};
}

function decode() {
	while (recognizer.isReady(stream)) recognizer.decode(stream);
	return recognizer.getResult(stream).text.trim();
}

function finish(text) {
	if (text) postMessage({ type: 'final', text });
	last = '';
}

self.onmessage = async ({ data: msg }) => {
	try {
		if (msg.type === 'init') {
			await init(msg.base);
			postMessage({ type: 'ready' });
		} else if (msg.type === 'audio' && stream) {
			sampleRate = msg.sampleRate;
			stream.acceptWaveform(sampleRate, msg.samples);
			const text = decode();
			if (text !== last) {
				last = text;
				postMessage({ type: 'partial', text });
			}
			if (recognizer.isEndpoint(stream)) {
				finish(text);
				recognizer.reset(stream);
			}
		} else if (msg.type === 'flush' && stream) {
			// Pad with silence so the model emits the tail, then start a fresh stream.
			stream.acceptWaveform(sampleRate, new Float32Array(sampleRate / 2));
			stream.inputFinished();
			finish(decode());
			stream.free();
			stream = recognizer.createStream();
			postMessage({ type: 'flushed' });
		}
	} catch (e) {
		postMessage({ type: 'error', message: e?.message ?? String(e) });
	}
};
