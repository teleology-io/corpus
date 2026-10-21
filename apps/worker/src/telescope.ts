import { and, eq, inArray, lt } from 'drizzle-orm';
import { db, schema } from '@corpus/db';
import { storage } from '@corpus/db/storage';

const { telescopeVideo: video } = schema;

/**
 * Telescope recordings whose recorder never called complete (tab closed, crash, upload
 * failure) — abort the multipart upload, delete any stored objects, then the row.
 */
export async function purgeStaleRecordings(olderThanHours = 24) {
	const stale = await db
		.select()
		.from(video)
		.where(
			and(
				inArray(video.status, ['uploading', 'failed']),
				lt(video.createdAt, new Date(Date.now() - olderThanHours * 3600_000))
			)
		);
	if (!stale.length) return;
	const s = storage();
	for (const row of stale) {
		if (row.uploadId) await s.abortUpload(row.fileKey, row.uploadId);
		await s.remove(row.fileKey);
		if (row.thumbKey) await s.remove(row.thumbKey);
		await db.delete(video).where(eq(video.id, row.id));
	}
	console.log(`[telescope] purged ${stale.length} abandoned recording(s)`);
}
