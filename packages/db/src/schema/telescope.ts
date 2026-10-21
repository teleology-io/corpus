import { relations } from 'drizzle-orm';
import {
	bigint,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import { createdAt, id, tstz, updatedAt, userRef, workspaceRef } from './_helpers';

/** One recognized utterance; times in seconds from the start of the video. */
export interface TranscriptSegment {
	start: number;
	end: number;
	text: string;
}

/**
 * A Telescope screen recording. Private to its owner unless visibility = 'link', in which case
 * anyone holding `linkToken` can watch at /v/<token>. The token survives turning the link off,
 * so turning it back on restores the same URL.
 */
export const telescopeVideo = pgTable(
	'telescope_video',
	{
		id: id(),
		workspaceId: workspaceRef(),
		ownerId: userRef('owner_id').notNull(),
		title: text('title').notNull().default(''),
		/** uploading | ready | failed */
		status: text('status').notNull().default('uploading'),
		mime: text('mime').notNull(),
		bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
		durationMs: integer('duration_ms').notNull().default(0),
		width: integer('width'),
		height: integer('height'),
		/** Storage key of the video object (see @corpus/db/storage) */
		fileKey: text('file_key').notNull(),
		/** Multipart upload in flight; cleared on complete */
		uploadId: text('upload_id'),
		thumbKey: text('thumb_key'),
		/** private | link */
		visibility: text('visibility').notNull().default('private'),
		linkToken: text('link_token').unique(),
		transcript: jsonb('transcript').$type<TranscriptSegment[]>(),
		/** pending | done | failed */
		transcriptStatus: text('transcript_status').notNull().default('pending'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		index('telescope_video_owner_idx').on(t.ownerId, t.createdAt),
		index('telescope_video_status_idx').on(t.status, t.createdAt)
	]
);

/**
 * One row per unique viewer of a video. viewerKey is `u:<userId>` for signed-in viewers and
 * `a:<cookie id>` for anonymous ones, so repeat visits upsert instead of inflating counts.
 */
export const telescopeView = pgTable(
	'telescope_view',
	{
		id: id(),
		videoId: uuid('video_id')
			.notNull()
			.references(() => telescopeVideo.id, { onDelete: 'cascade' }),
		viewerKey: text('viewer_key').notNull(),
		// Keep the row (and the count) if the viewer's account is deleted.
		viewerUserId: text('viewer_user_id').references(() => user.id, { onDelete: 'set null' }),
		/** Longest single-session watch time reported by the player */
		watchedMs: integer('watched_ms').notNull().default(0),
		firstSeenAt: tstz('first_seen_at').defaultNow().notNull(),
		lastSeenAt: tstz('last_seen_at').defaultNow().notNull()
	},
	(t) => [uniqueIndex('telescope_view_viewer_uq').on(t.videoId, t.viewerKey)]
);

export const telescopeVideoRelations = relations(telescopeVideo, ({ many }) => ({
	views: many(telescopeView)
}));
export const telescopeViewRelations = relations(telescopeView, ({ one }) => ({
	video: one(telescopeVideo, { fields: [telescopeView.videoId], references: [telescopeVideo.id] })
}));
