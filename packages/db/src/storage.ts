import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import {
	AbortMultipartUploadCommand,
	CompleteMultipartUploadCommand,
	CreateMultipartUploadCommand,
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand,
	S3Client,
	UploadPartCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomToken } from '@corpus/core/crypto';
import { PART_SIZE } from '@corpus/core/telescope';
import { env, optionalEnv } from './env';

/**
 * Object storage for Telescope videos and thumbnails. Every setting is a STORAGE_* env var:
 *   STORAGE_DRIVER      local (default) | r2
 *   STORAGE_VIDEO_DIR   local driver root (default ./uploads/videos)
 *   STORAGE_MAX_BYTES   per-video cap (default 2 GiB)
 *   STORAGE_ACCOUNT_ID, STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY, STORAGE_BUCKET   (r2)
 *
 * Uploads are multipart in both drivers so the client has one code path: r2 hands out
 * presigned part URLs (the browser uploads straight to the bucket), local writes parts itself.
 */

export interface UploadedPart {
	n: number;
	etag: string;
}

interface Common {
	createUpload(key: string, mime: string): Promise<string>;
	completeUpload(key: string, uploadId: string, parts: UploadedPart[]): Promise<number>;
	abortUpload(key: string, uploadId: string): Promise<void>;
	put(key: string, bytes: Uint8Array, mime: string): Promise<void>;
	remove(key: string): Promise<void>;
}

export interface R2Storage extends Common {
	driver: 'r2';
	signPart(key: string, uploadId: string, n: number): Promise<string>;
	signGet(key: string, ttlSeconds: number): Promise<string>;
}

export interface LocalStorage extends Common {
	driver: 'local';
	writePart(
		key: string,
		uploadId: string,
		n: number,
		body: ReadableStream<Uint8Array>
	): Promise<string>;
	size(key: string): Promise<number | null>;
	read(key: string, start: number, end: number): ReadableStream<Uint8Array>;
}

export type Storage = R2Storage | LocalStorage;

export { PART_SIZE };
export const MAX_PARTS = 10_000;

export function maxVideoBytes() {
	return Number(optionalEnv('STORAGE_MAX_BYTES') ?? 2 * 1024 ** 3);
}

const KEY_RE = /^[a-z]+\/[A-Za-z0-9_-]+(\.[a-z0-9]+)?$/;
function checkKey(key: string) {
	if (!KEY_RE.test(key)) throw new Error(`Invalid storage key: ${key}`);
}

function r2(): R2Storage {
	const missing = [
		'STORAGE_ACCOUNT_ID',
		'STORAGE_ACCESS_KEY_ID',
		'STORAGE_SECRET_ACCESS_KEY',
		'STORAGE_BUCKET'
	].filter((k) => !optionalEnv(k));
	if (missing.length) {
		throw new Error(`STORAGE_DRIVER=r2 but ${missing.join(', ')} not set — see .env.example`);
	}
	const Bucket = env('STORAGE_BUCKET');
	const client = new S3Client({
		region: 'auto',
		endpoint: `https://${env('STORAGE_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
		credentials: {
			accessKeyId: env('STORAGE_ACCESS_KEY_ID'),
			secretAccessKey: env('STORAGE_SECRET_ACCESS_KEY')
		},
		// Otherwise the SDK signs CRC32 checksum params into presigned part URLs, which a plain
		// browser PUT can't satisfy.
		requestChecksumCalculation: 'WHEN_REQUIRED',
		responseChecksumValidation: 'WHEN_REQUIRED'
	});
	return {
		driver: 'r2',
		async createUpload(key, mime) {
			checkKey(key);
			const res = await client.send(
				new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: mime })
			);
			if (!res.UploadId) throw new Error('R2 did not return an upload id');
			return res.UploadId;
		},
		signPart(key, uploadId, n) {
			return getSignedUrl(
				client,
				new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: n }),
				{ expiresIn: 15 * 60 }
			);
		},
		async completeUpload(key, uploadId, parts) {
			await client.send(
				new CompleteMultipartUploadCommand({
					Bucket,
					Key: key,
					UploadId: uploadId,
					MultipartUpload: {
						Parts: [...parts]
							.sort((a, b) => a.n - b.n)
							.map((p) => ({ PartNumber: p.n, ETag: p.etag }))
					}
				})
			);
			const head = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
			return head.ContentLength ?? 0;
		},
		async abortUpload(key, uploadId) {
			await client
				.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }))
				.catch(() => {});
		},
		signGet(key, ttlSeconds) {
			return getSignedUrl(client, new GetObjectCommand({ Bucket, Key: key }), {
				expiresIn: ttlSeconds
			});
		},
		async put(key, bytes, mime) {
			checkKey(key);
			await client.send(new PutObjectCommand({ Bucket, Key: key, Body: bytes, ContentType: mime }));
		},
		async remove(key) {
			await client.send(new DeleteObjectCommand({ Bucket, Key: key })).catch(() => {});
		}
	};
}

function local(): LocalStorage {
	const root = resolve(optionalEnv('STORAGE_VIDEO_DIR') ?? './uploads/videos');
	const path = (key: string) => (checkKey(key), join(root, key));
	const partsDir = (key: string, uploadId: string) => {
		if (!/^[A-Za-z0-9_-]+$/.test(uploadId)) throw new Error('Invalid upload id');
		return `${path(key)}.parts-${uploadId}`;
	};
	return {
		driver: 'local',
		async createUpload(key) {
			const uploadId = randomToken(12);
			await mkdir(partsDir(key, uploadId), { recursive: true });
			return uploadId;
		},
		async writePart(key, uploadId, n, body) {
			const file = join(partsDir(key, uploadId), String(n));
			await pipeline(
				Readable.fromWeb(body as import('node:stream/web').ReadableStream),
				createWriteStream(file)
			);
			const { size } = await stat(file);
			return `"${n}-${size}"`;
		},
		async completeUpload(key, uploadId, parts) {
			const dir = partsDir(key, uploadId);
			const present = new Set(await readdir(dir));
			const ordered = [...parts].sort((a, b) => a.n - b.n);
			for (const p of ordered) {
				if (!present.has(String(p.n))) throw new Error(`Part ${p.n} was never uploaded`);
			}
			await mkdir(dirname(path(key)), { recursive: true });
			const out = createWriteStream(path(key));
			try {
				for (const p of ordered) {
					for await (const chunk of createReadStream(join(dir, String(p.n)))) {
						if (!out.write(chunk)) await once(out, 'drain');
					}
				}
			} finally {
				out.end();
				await finished(out);
			}
			await rm(dir, { recursive: true, force: true });
			return (await stat(path(key))).size;
		},
		async abortUpload(key, uploadId) {
			await rm(partsDir(key, uploadId), { recursive: true, force: true });
		},
		async put(key, bytes) {
			await mkdir(dirname(path(key)), { recursive: true });
			await writeFile(path(key), bytes);
		},
		async remove(key) {
			await rm(path(key), { force: true });
		},
		async size(key) {
			try {
				return (await stat(path(key))).size;
			} catch {
				return null;
			}
		},
		read(key, start, end) {
			return Readable.toWeb(
				createReadStream(path(key), { start, end })
			) as ReadableStream<Uint8Array>;
		}
	};
}

let instance: Storage | null = null;

/** The configured driver. Throws a descriptive error on first use if r2 is misconfigured. */
export function storage(): Storage {
	if (instance) return instance;
	const driver = optionalEnv('STORAGE_DRIVER') ?? 'local';
	if (driver !== 'local' && driver !== 'r2') {
		throw new Error(`STORAGE_DRIVER must be "local" or "r2", got "${driver}"`);
	}
	instance = driver === 'r2' ? r2() : local();
	return instance;
}
