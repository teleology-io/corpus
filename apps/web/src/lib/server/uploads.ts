import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { env } from '@corpus/db';
import { randomToken } from '@corpus/core/crypto';

const ALLOWED: Record<string, string> = {
	'image/png': '.png',
	'image/jpeg': '.jpg',
	'image/gif': '.gif',
	'image/webp': '.webp',
	'image/svg+xml': '.svg'
};
const TYPES = Object.fromEntries(Object.entries(ALLOWED).map(([t, e]) => [e, t]));
export const MAX_UPLOAD = 10 * 1024 * 1024;

const dir = () => resolve(env('UPLOAD_DIR', './uploads'));

/** Local-disk storage adapter. Swap for S3 by keeping this signature. */
export async function saveUpload(file: File) {
	const ext = ALLOWED[file.type];
	if (!ext) throw new Error('Unsupported file type');
	if (file.size > MAX_UPLOAD) throw new Error('File too large');
	await mkdir(dir(), { recursive: true });
	const name = `${randomToken(16)}${ext}`;
	await writeFile(join(dir(), name), Buffer.from(await file.arrayBuffer()));
	return `/uploads/${name}`;
}

export async function readUpload(name: string) {
	if (!/^[A-Za-z0-9_-]+\.[a-z]+$/.test(name)) return null;
	const type = TYPES[extname(name)];
	if (!type) return null;
	try {
		return { data: await readFile(join(dir(), name)), type };
	} catch {
		return null;
	}
}
