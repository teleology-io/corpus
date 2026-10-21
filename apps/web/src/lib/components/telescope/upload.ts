import { PART_SIZE } from '@corpus/core/telescope';

interface Part {
	n: number;
	etag: string;
}

async function json<T>(res: Response): Promise<T> {
	if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`);
	return res.json() as Promise<T>;
}

/**
 * Streams a recording to storage while it's still being recorded: buffers MediaRecorder output
 * and uploads exactly PART_SIZE parts (R2 needs equal-sized parts), one at a time, in order.
 * The server hands out each part's URL — presigned R2 or the local chunk route — so this code
 * doesn't care which storage driver is active.
 */
export class PartUploader {
	private pending: Blob[] = [];
	private pendingBytes = 0;
	private next = 1;
	private parts: Part[] = [];
	private queue: Promise<void> = Promise.resolve();
	private failed: Error | null = null;
	uploaded = 0;
	total = 0;

	constructor(
		private videoId: string,
		private onprogress?: (uploaded: number, total: number) => void
	) {}

	/** Feed recorder output. Full parts are queued for upload immediately. */
	push(chunk: Blob) {
		if (!chunk.size) return;
		this.pending.push(chunk);
		this.pendingBytes += chunk.size;
		this.total += chunk.size;
		this.onprogress?.(this.uploaded, this.total);
		while (this.pendingBytes >= PART_SIZE) {
			// Untyped so the browser doesn't add a Content-Type the presigned URL didn't sign.
			const all = new Blob(this.pending);
			this.enqueue(all.slice(0, PART_SIZE));
			const rest = all.slice(PART_SIZE);
			this.pending = rest.size ? [rest] : [];
			this.pendingBytes = rest.size;
		}
	}

	/** Uploads the remainder as the final part and resolves with every part's ETag. */
	async finish(): Promise<Part[]> {
		if (this.pendingBytes || !this.parts.length) {
			this.enqueue(new Blob(this.pending));
			this.pending = [];
			this.pendingBytes = 0;
		}
		await this.queue;
		if (this.failed) throw this.failed;
		return this.parts;
	}

	private enqueue(blob: Blob) {
		const n = this.next++;
		this.queue = this.queue.then(async () => {
			if (this.failed) return;
			try {
				this.parts.push({ n, etag: await this.uploadPart(n, blob) });
				this.uploaded += blob.size;
				this.onprogress?.(this.uploaded, this.total);
			} catch (e) {
				this.failed = e as Error;
			}
		});
	}

	private async uploadPart(n: number, blob: Blob) {
		let lastError: unknown;
		for (let attempt = 0; attempt < 4; attempt++) {
			if (attempt) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
			try {
				const { url } = await json<{ url: string }>(
					await fetch(`/api/telescope/${this.videoId}/parts/${n}`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ size: blob.size })
					})
				);
				const res = await fetch(url, { method: 'PUT', body: blob });
				if (!res.ok) throw new Error(`Part ${n} upload failed (${res.status})`);
				const etag = res.headers.get('ETag');
				// R2 only exposes ETag cross-origin if the bucket CORS policy lists it.
				if (!etag) throw new Error('Upload succeeded but ETag was hidden — check bucket CORS');
				return etag;
			} catch (e) {
				lastError = e;
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}
}

export async function createDraft(mime: string) {
	return json<{ id: string }>(
		await fetch('/api/telescope', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ mime })
		})
	);
}

export async function completeDraft(
	id: string,
	body: { parts: Part[]; durationMs: number; width: number | null; height: number | null }
) {
	return json<{ id: string }>(
		await fetch(`/api/telescope/${id}/complete`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		})
	);
}

export async function uploadThumb(id: string, jpeg: Blob) {
	const res = await fetch(`/api/telescope/${id}/thumb`, {
		method: 'PUT',
		headers: { 'Content-Type': 'image/jpeg' },
		body: jpeg
	});
	if (!res.ok) throw new Error('Thumbnail upload failed');
}
