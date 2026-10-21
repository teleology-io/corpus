import { error } from '@sveltejs/kit';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '@corpus/db';
import { videoRole } from '@corpus/db/access';
import { MAX_PARTS, maxVideoBytes, PART_SIZE, storage } from '@corpus/db/storage';
import { randomToken } from '@corpus/core/crypto';
import { parseRange } from '@corpus/core/telescope';
import type { VideoSummary, VideoViewer } from '#lib/telescope.js';
import type { Ctx } from './ctx.js';

const { telescopeVideo: video, telescopeView: view, user } = schema;
type Video = typeof video.$inferSelect;

const MIMES: Record<string, string> = { 'video/webm': '.webm', 'video/mp4': '.mp4' };

export async function requireVideo(ctx: Ctx, id: string) {
	if (!z.uuid().safeParse(id).success) error(404, 'Video not found');
	if ((await videoRole(ctx.userId, id)) !== 'owner') error(404, 'Video not found');
	const [row] = await db.select().from(video).where(eq(video.id, id)).limit(1);
	if (!row) error(404, 'Video not found');
	return row;
}

/** Unique-viewer counts per video: total, signed-in (`u:` keys) and anonymous (`a:` keys). */
async function viewCounts(ids: string[]) {
	if (!ids.length) return new Map<string, { total: number; authed: number; anon: number }>();
	const rows = await db
		.select({
			videoId: view.videoId,
			total: sql<number>`count(*)::int`,
			authed: sql<number>`count(*) filter (where ${view.viewerKey} like 'u:%')::int`
		})
		.from(view)
		.where(inArray(view.videoId, ids))
		.groupBy(view.videoId);
	return new Map(
		rows.map((r) => [r.videoId, { total: r.total, authed: r.authed, anon: r.total - r.authed }])
	);
}

function summary(v: Video, views = { total: 0, authed: 0, anon: 0 }): VideoSummary {
	return {
		id: v.id,
		title: v.title,
		status: v.status as VideoSummary['status'],
		durationMs: v.durationMs,
		bytes: v.bytes,
		width: v.width,
		height: v.height,
		visibility: v.visibility as VideoSummary['visibility'],
		linkToken: v.visibility === 'link' ? v.linkToken : null,
		hasThumb: !!v.thumbKey,
		transcriptStatus: v.transcriptStatus as VideoSummary['transcriptStatus'],
		createdAt: v.createdAt.toISOString(),
		views
	};
}

export async function listVideos(ctx: Ctx) {
	const rows = await db
		.select()
		.from(video)
		.where(
			and(
				eq(video.ownerId, ctx.userId),
				eq(video.workspaceId, ctx.workspaceId),
				eq(video.status, 'ready')
			)
		)
		.orderBy(desc(video.createdAt));
	const counts = await viewCounts(rows.map((r) => r.id));
	return rows.map((r) => summary(r, counts.get(r.id)));
}

export async function videoDetail(ctx: Ctx, id: string) {
	const row = await requireVideo(ctx, id);
	const counts = await viewCounts([row.id]);
	return { video: summary(row, counts.get(row.id)), transcript: row.transcript ?? [] };
}

// ── Upload ─────────────────────────────────────────────────────────────────────────────

export const draftInput = z.object({
	mime: z.string().max(100),
	title: z.string().max(200).optional()
});

/** Starts a recording: a draft row plus a multipart upload the recorder streams parts into. */
export async function createDraft(ctx: Ctx, input: z.infer<typeof draftInput>) {
	const base = input.mime.split(';')[0]!.trim().toLowerCase();
	const ext = MIMES[base];
	if (!ext) error(400, 'Unsupported video type');
	const fileKey = `videos/${randomToken(18)}${ext}`;
	const uploadId = await storage().createUpload(fileKey, base);
	const title =
		input.title?.trim() ||
		`Recording ${new Date().toLocaleString('en-US', { timeZone: ctx.tz, dateStyle: 'medium', timeStyle: 'short' })}`;
	const [row] = await db
		.insert(video)
		.values({
			workspaceId: ctx.workspaceId,
			ownerId: ctx.userId,
			title,
			mime: base,
			fileKey,
			uploadId
		})
		.returning();
	return { id: row!.id };
}

async function requireUploading(ctx: Ctx, id: string) {
	const row = await requireVideo(ctx, id);
	if (row.status !== 'uploading' || !row.uploadId) error(409, 'Upload already finished');
	return row as Video & { uploadId: string };
}

function checkPart(n: number, size: number) {
	if (!Number.isInteger(n) || n < 1 || n > MAX_PARTS) error(400, 'Bad part number');
	if (size < 1 || size > PART_SIZE) error(400, 'Bad part size');
	// Every part before n is exactly PART_SIZE, so this bounds the total without any state.
	if ((n - 1) * PART_SIZE + size > maxVideoBytes()) error(413, 'Recording is too large');
}

/** Where the client should PUT part `n`: a presigned R2 URL, or our own chunk route locally. */
export async function partTarget(ctx: Ctx, id: string, n: number, size: number) {
	checkPart(n, size);
	const row = await requireUploading(ctx, id);
	const s = storage();
	if (s.driver === 'r2') return { url: await s.signPart(row.fileKey, row.uploadId, n) };
	return { url: `/api/telescope/${id}/chunks/${n}` };
}

/** Local driver only: receives a part body and returns its ETag, mirroring R2. */
export async function writeLocalPart(ctx: Ctx, id: string, n: number, request: Request) {
	const s = storage();
	if (s.driver !== 'local') error(404, 'Not found');
	// Require a declared length so the size checks hold; the runtime rejects bodies that differ.
	const length = Number(request.headers.get('content-length'));
	if (!length) error(411, 'Content-Length required');
	checkPart(n, length);
	const row = await requireUploading(ctx, id);
	if (!request.body) error(400, 'Missing body');
	return s.writePart(row.fileKey, row.uploadId, n, request.body);
}

export const completeInput = z.object({
	parts: z
		.array(z.object({ n: z.number().int().min(1).max(MAX_PARTS), etag: z.string().max(200) }))
		.min(1)
		.max(MAX_PARTS),
	durationMs: z
		.number()
		.int()
		.min(0)
		.max(24 * 3600 * 1000),
	width: z.number().int().positive().max(16384).nullable(),
	height: z.number().int().positive().max(16384).nullable()
});

export async function completeVideo(ctx: Ctx, id: string, input: z.infer<typeof completeInput>) {
	const row = await requireUploading(ctx, id);
	let bytes: number;
	try {
		bytes = await storage().completeUpload(row.fileKey, row.uploadId, input.parts);
	} catch (e) {
		error(400, `Could not finish upload: ${(e as Error).message}`);
	}
	if (bytes > maxVideoBytes()) {
		await storage().remove(row.fileKey);
		await db.update(video).set({ status: 'failed', uploadId: null }).where(eq(video.id, id));
		error(413, 'Recording is too large');
	}
	await db
		.update(video)
		.set({
			status: 'ready',
			uploadId: null,
			bytes,
			durationMs: input.durationMs,
			width: input.width,
			height: input.height
		})
		.where(eq(video.id, id));
	return { id };
}

const MAX_THUMB = 2 * 1024 * 1024;

export async function putThumb(ctx: Ctx, id: string, request: Request) {
	const row = await requireVideo(ctx, id);
	if (request.headers.get('content-type') !== 'image/jpeg') error(400, 'Thumbnail must be JPEG');
	const bytes = new Uint8Array(await request.arrayBuffer());
	if (!bytes.length || bytes.length > MAX_THUMB) error(400, 'Bad thumbnail');
	const thumbKey = row.thumbKey ?? `thumbs/${randomToken(18)}.jpg`;
	await storage().put(thumbKey, bytes, 'image/jpeg');
	await db.update(video).set({ thumbKey }).where(eq(video.id, id));
}

// ── Edit / share / delete ───────────────────────────────────────────────────────────────

export const videoPatch = z.object({ title: z.string().trim().min(1).max(200) });

export async function updateVideo(ctx: Ctx, id: string, patch: z.infer<typeof videoPatch>) {
	await requireVideo(ctx, id);
	await db.update(video).set({ title: patch.title }).where(eq(video.id, id));
}

/**
 * Turns the public link on (reusing the existing token unless `reset`) or off. Off keeps the
 * token so switching back on restores the same URL; reset mints a new one, killing the old URL.
 */
export async function setLink(ctx: Ctx, id: string, enabled: boolean, reset = false) {
	const row = await requireVideo(ctx, id);
	if (!enabled) {
		await db.update(video).set({ visibility: 'private' }).where(eq(video.id, id));
		return { visibility: 'private' as const, linkToken: null };
	}
	const linkToken = !row.linkToken || reset ? randomToken(18) : row.linkToken;
	await db.update(video).set({ visibility: 'link', linkToken }).where(eq(video.id, id));
	return { visibility: 'link' as const, linkToken };
}

/** Removes the row and its stored objects (aborting a multipart upload still in flight). */
export async function purgeVideo(row: Video) {
	const s = storage();
	if (row.uploadId) await s.abortUpload(row.fileKey, row.uploadId);
	await s.remove(row.fileKey);
	if (row.thumbKey) await s.remove(row.thumbKey);
	await db.delete(video).where(eq(video.id, row.id));
}

export async function deleteVideo(ctx: Ctx, id: string) {
	await purgeVideo(await requireVideo(ctx, id));
}

// ── Transcript ──────────────────────────────────────────────────────────────────────────

export const transcriptInput = z.union([
	z.object({
		segments: z
			.array(
				z.object({
					start: z.number().min(0),
					end: z.number().min(0),
					text: z.string().max(5000)
				})
			)
			.max(20_000)
	}),
	z.object({ failed: z.literal(true) })
]);

export async function saveTranscript(ctx: Ctx, id: string, input: z.infer<typeof transcriptInput>) {
	await requireVideo(ctx, id);
	await db
		.update(video)
		.set(
			'failed' in input
				? { transcriptStatus: 'failed' }
				: { transcript: input.segments, transcriptStatus: 'done' }
		)
		.where(eq(video.id, id));
}

// ── Views ───────────────────────────────────────────────────────────────────────────────

export type Viewer = { userId: string } | { anonId: string };

/**
 * Upserts one row per unique viewer. The owner's own plays never count. watchedMs keeps the
 * best session so far, so heartbeats and repeat visits don't inflate it.
 */
export async function recordView(v: Video, viewer: Viewer, watchedMs: number) {
	if ('userId' in viewer && viewer.userId === v.ownerId) return;
	const viewerKey = 'userId' in viewer ? `u:${viewer.userId}` : `a:${viewer.anonId}`;
	const ms = Math.max(0, Math.min(Math.round(watchedMs), 24 * 3600_000));
	await db
		.insert(view)
		.values({
			videoId: v.id,
			viewerKey,
			viewerUserId: 'userId' in viewer ? viewer.userId : null,
			watchedMs: ms
		})
		.onConflictDoUpdate({
			target: [view.videoId, view.viewerKey],
			set: { watchedMs: sql`greatest(${view.watchedMs}, ${ms})`, lastSeenAt: new Date() }
		});
}

export async function listViewers(ctx: Ctx, id: string): Promise<VideoViewer[]> {
	await requireVideo(ctx, id);
	const rows = await db
		.select({
			name: user.name,
			image: user.image,
			email: user.email,
			watchedMs: view.watchedMs,
			firstSeenAt: view.firstSeenAt,
			lastSeenAt: view.lastSeenAt
		})
		.from(view)
		.innerJoin(user, eq(user.id, view.viewerUserId))
		.where(eq(view.videoId, id))
		.orderBy(desc(view.lastSeenAt));
	return rows.map((r) => ({
		...r,
		firstSeenAt: r.firstSeenAt.toISOString(),
		lastSeenAt: r.lastSeenAt.toISOString()
	}));
}

// ── Serving ─────────────────────────────────────────────────────────────────────────────

/**
 * Serves a stored object after the caller has checked access. R2: a short-lived presigned
 * redirect (R2 handles Range itself). Local: streamed here with Range support for seeking.
 */
export async function serveObject(request: Request, key: string, mime: string) {
	const s = storage();
	if (s.driver === 'r2') {
		return new Response(null, {
			status: 302,
			headers: { Location: await s.signGet(key, 3600), 'Cache-Control': 'no-store' }
		});
	}
	const size = await s.size(key);
	if (size === null) error(404, 'Not found');
	const headers: Record<string, string> = {
		'Content-Type': mime,
		'Accept-Ranges': 'bytes',
		'Cache-Control': 'private, max-age=3600',
		'X-Content-Type-Options': 'nosniff'
	};
	const range = parseRange(request.headers.get('range'), size);
	if (range === 'unsatisfiable') {
		return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
	}
	if (!range) {
		if (size === 0) return new Response(null, { headers: { ...headers, 'Content-Length': '0' } });
		return new Response(s.read(key, 0, size - 1), {
			headers: { ...headers, 'Content-Length': String(size) }
		});
	}
	return new Response(s.read(key, range.start, range.end), {
		status: 206,
		headers: {
			...headers,
			'Content-Length': String(range.end - range.start + 1),
			'Content-Range': `bytes ${range.start}-${range.end}/${size}`
		}
	});
}

/** httpOnly cookie identifying an anonymous viewer, scoped to the /v share pages. */
export const ANON_COOKIE = 'tv_anon';
