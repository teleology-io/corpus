import os from 'node:os';
import { eq, sql as q } from 'drizzle-orm';
import { db, sql } from './index';
import { jobRun, jobState, serviceHeartbeat } from './schema/admin';

/**
 * Operational plumbing shared by the worker, collab and the admin panel: the job registry, run
 * tracking, pause flags, "run now" requests and process heartbeats.
 */

export const JOBS = {
	tick: { label: 'Reminder scheduler', schedule: 'Every minute' },
	deliver: { label: 'Notification delivery', schedule: 'Every 30 seconds + on new notification' },
	poll: { label: 'Integration polling', schedule: 'Every 15 seconds' },
	cleanup: { label: 'Daily cleanup', schedule: 'Daily at 03:17' },
	'telescope-cleanup': { label: 'Telescope cleanup', schedule: 'Hourly at :41' }
} as const satisfies Record<string, { label: string; schedule: string }>;

export type JobName = keyof typeof JOBS;
export const isJobName = (n: string): n is JobName => Object.hasOwn(JOBS, n);

/** The worker listens here; the payload is a job name. */
export const RUN_JOB_CHANNEL = 'corpus_admin_run_job';

/** Heartbeats older than this mean the process is down. */
export const HEARTBEAT_MS = 15_000;
export const STALE_AFTER_MS = HEARTBEAT_MS * 3;

const RUN_RETENTION_DAYS = 3;

/**
 * Wrap a job so every run is recorded and paused jobs are skipped (unless `manual`).
 * Errors are recorded and rethrown.
 */
export function tracked(name: JobName, fn: () => Promise<unknown>) {
	return async (trigger: 'auto' | 'manual' = 'auto') => {
		if (trigger === 'auto') {
			const [state] = await db
				.select({ paused: jobState.paused })
				.from(jobState)
				.where(eq(jobState.name, name))
				.limit(1);
			if (state?.paused) return;
		}
		const startedAt = new Date();
		let error: string | null = null;
		try {
			await fn();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			throw e;
		} finally {
			await record(name, startedAt, error, trigger).catch((e) =>
				console.error(`[ops] could not record ${name} run`, e)
			);
		}
	};
}

async function record(name: JobName, startedAt: Date, error: string | null, trigger: string) {
	const finishedAt = new Date();
	const durationMs = finishedAt.getTime() - startedAt.getTime();
	const ok = error === null;
	const err = error?.slice(0, 2000) ?? null;
	await db.insert(jobRun).values({ job: name, startedAt, durationMs, ok, error: err, trigger });
	await db
		.insert(jobState)
		.values({
			name,
			lastStartedAt: startedAt,
			lastFinishedAt: finishedAt,
			lastOk: ok,
			lastError: err,
			lastDurationMs: durationMs,
			runs: 1,
			failures: ok ? 0 : 1
		})
		.onConflictDoUpdate({
			target: jobState.name,
			set: {
				lastStartedAt: startedAt,
				lastFinishedAt: finishedAt,
				lastOk: ok,
				lastError: err,
				lastDurationMs: durationMs,
				runs: q`${jobState.runs} + 1`,
				failures: ok ? jobState.failures : q`${jobState.failures} + 1`
			}
		});
}

export async function pruneJobRuns() {
	await db
		.delete(jobRun)
		.where(q`${jobRun.startedAt} < now() - make_interval(days => ${RUN_RETENTION_DAYS})`);
}

export async function setJobPaused(name: JobName, paused: boolean, by: string) {
	await db
		.insert(jobState)
		.values({ name, paused, pausedBy: paused ? by : null, pausedAt: paused ? new Date() : null })
		.onConflictDoUpdate({
			target: jobState.name,
			set: { paused, pausedBy: paused ? by : null, pausedAt: paused ? new Date() : null }
		});
}

export async function requestJobRun(name: JobName) {
	await sql.notify(RUN_JOB_CHANNEL, name);
}

/** Upsert this process's heartbeat now and every HEARTBEAT_MS. Returns a stop function. */
export function startHeartbeat(service: string, meta: () => Record<string, unknown> = () => ({})) {
	const instance = `${os.hostname()}:${process.pid}`;
	const startedAt = new Date();
	const beat = () =>
		db
			.insert(serviceHeartbeat)
			.values({ service, instance, startedAt, beatAt: new Date(), meta: meta() })
			.onConflictDoUpdate({
				target: serviceHeartbeat.service,
				set: { instance, startedAt, beatAt: new Date(), meta: meta() }
			})
			.catch((e) => console.error(`[heartbeat] ${service}`, e));
	void beat();
	const timer = setInterval(beat, HEARTBEAT_MS);
	return () => clearInterval(timer);
}
