// Downloads the Vosk speech model used by note dictation into apps/web/static/models.
// Skips the download when the file is already present.
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

const NAME = 'vosk-model-small-en-us-0.15.tar.gz';
const URL = `https://ccoreilly.github.io/vosk-browser/models/${NAME}`;
const DIR = 'apps/web/static/models';
const OUT = `${DIR}/${NAME}`;

if (existsSync(OUT)) process.exit(0);
mkdirSync(DIR, { recursive: true });
console.log(`Downloading ${NAME} (~40MB)…`);
const res = await fetch(URL);
if (!res.ok) {
	console.error(`Model download failed: ${res.status} ${res.statusText}`);
	process.exit(1);
}
await writeFile(`${OUT}.part`, Buffer.from(await res.arrayBuffer()));
renameSync(`${OUT}.part`, OUT);
