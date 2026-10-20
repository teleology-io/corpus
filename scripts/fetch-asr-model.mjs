// Downloads the sherpa-onnx WebAssembly build (streaming Zipformer, English) used by note
// dictation into apps/web/static/sherpa/<version>. Skips the download when already present.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep in sync with ASR_VERSION in apps/web/src/lib/components/notes/dictation.ts.
const VERSION = 'v1.13.7';
const NAME = `sherpa-onnx-wasm-simd-${VERSION}-en-asr-zipformer`;
const URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/${VERSION}/${NAME}.tar.bz2`;
const OUT = `apps/web/static/sherpa/${VERSION}`;
const FILES = [
	'sherpa-onnx-asr.js',
	'sherpa-onnx-wasm-main-asr.js',
	'sherpa-onnx-wasm-main-asr.wasm',
	'sherpa-onnx-wasm-main-asr.data'
];

if (FILES.every((f) => existsSync(join(OUT, f)))) process.exit(0);

console.log(`Downloading speech model ${NAME} (~175MB)…`);
const res = await fetch(URL);
if (!res.ok) {
	console.error(`Speech model download failed: ${res.status} ${res.statusText}`);
	process.exit(1);
}
const tmp = mkdtempSync(join(tmpdir(), 'corpus-asr-'));
try {
	const archive = join(tmp, 'asr.tar.bz2');
	await writeFile(archive, Buffer.from(await res.arrayBuffer()));
	execFileSync('tar', ['xjf', archive, '-C', tmp]);
	mkdirSync(OUT, { recursive: true });
	for (const f of FILES) copyFileSync(join(tmp, NAME, f), join(OUT, f));
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
