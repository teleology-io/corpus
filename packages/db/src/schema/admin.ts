import { boolean, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { user } from './auth';
import { createdAt, id, tstz } from './_helpers';

/** Every action taken through the admin panel. Append-only. */
export const adminAudit = pgTable(
	'admin_audit',
	{
		id: id(),
		// Kept when the actor is deleted so the trail survives.
		actorId: text('actor_id').references(() => user.id, { onDelete: 'set null' }),
		actorEmail: text('actor_email').notNull(),
		/** e.g. `job.pause`, `user.disable` */
		action: text('action').notNull(),
		targetType: text('target_type'),
		targetId: text('target_id'),
		/** Required for destructive actions (the confirm modal asks for it). */
		reason: text('reason'),
		meta: jsonb('meta').$type<Record<string, unknown>>(),
		createdAt: createdAt()
	},
	(t) => [index('admin_audit_created_idx').on(t.createdAt)]
);

/**
 * One row per background job the worker runs. Written by `tracked()` in `@corpus/db/ops`; the
 * admin panel flips `paused`, and the worker skips paused jobs.
 */
export const jobState = pgTable('job_state', {
	name: text('name').primaryKey(),
	paused: boolean('paused').notNull().default(false),
	pausedBy: text('paused_by'),
	pausedAt: tstz('paused_at'),
	lastStartedAt: tstz('last_started_at'),
	lastFinishedAt: tstz('last_finished_at'),
	lastOk: boolean('last_ok'),
	lastError: text('last_error'),
	lastDurationMs: integer('last_duration_ms'),
	runs: integer('runs').notNull().default(0),
	failures: integer('failures').notNull().default(0)
});

/** Run history. Pruned by the daily cleanup job. */
export const jobRun = pgTable(
	'job_run',
	{
		id: id(),
		job: text('job').notNull(),
		startedAt: tstz('started_at').notNull(),
		durationMs: integer('duration_ms').notNull(),
		ok: boolean('ok').notNull(),
		error: text('error'),
		/** `manual` when requested from the admin panel */
		trigger: text('trigger').notNull().default('auto')
	},
	(t) => [index('job_run_job_started_idx').on(t.job, t.startedAt)]
);

/** Liveness for long-running processes (worker, collab). Upserted every few seconds. */
export const serviceHeartbeat = pgTable('service_heartbeat', {
	service: text('service').primaryKey(),
	instance: text('instance').notNull(),
	startedAt: tstz('started_at').notNull(),
	beatAt: tstz('beat_at').notNull(),
	meta: jsonb('meta').$type<Record<string, unknown>>()
});
