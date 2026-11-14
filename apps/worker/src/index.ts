import { PgBoss } from 'pg-boss';
import { env, sql } from '@corpus/db';
import { DELIVERY_CHANNEL } from '@corpus/db/notify';
import { tick } from './scheduler';
import { cleanup, deliverPending } from './delivery';
import { purgeSlackCaches } from './slack-sync';
import { pollDue } from './integrations';
import { purgeStaleRecordings } from './telescope';
import {
	RUN_JOB_CHANNEL,
	isJobName,
	pruneJobRuns,
	startHeartbeat,
	tracked,
	type JobName
} from '@corpus/db/ops';

const POLL_CHANNEL = 'corpus_poll';

/**
 * Serialize a recurring async job so overlapping triggers coalesce into one extra run. Runs are
 * recorded for the admin panel and skipped while the job is paused there (manual runs excepted).
 */
function serial(name: JobName, fn: () => Promise<unknown>) {
	const job = tracked(name, fn);
	let running = false;
	let again: 'auto' | 'manual' | null = null;
	const run = async (trigger: 'auto' | 'manual' = 'auto'): Promise<void> => {
		if (running) {
			if (again !== 'manual') again = trigger;
			return;
		}
		running = true;
		try {
			await job(trigger);
		} catch (e) {
			console.error(`[${name}]`, e);
		} finally {
			running = false;
			if (again) {
				const next = again;
				again = null;
				void run(next);
			}
		}
	};
	return run;
}

const boss = new PgBoss(env('DATABASE_URL'));
boss.on('error', (e) => console.error('[pg-boss]', e));
await boss.start();

// Cron-driven jobs: pg-boss guarantees one run per minute across all worker instances.
for (const q of ['tick', 'cleanup', 'telescope-cleanup']) await boss.createQueue(q);
await boss.schedule('tick', '* * * * *');
await boss.schedule('cleanup', '17 3 * * *');
await boss.schedule('telescope-cleanup', '41 * * * *');
const runners = {
	tick: serial('tick', tick),
	cleanup: serial('cleanup', async () => {
		await cleanup();
		await purgeSlackCaches();
		await pruneJobRuns();
	}),
	'telescope-cleanup': serial('telescope-cleanup', purgeStaleRecordings),
	deliver: serial('deliver', deliverPending),
	poll: serial('poll', () => pollDue())
} satisfies Record<JobName, (trigger?: 'auto' | 'manual') => Promise<void>>;

await boss.work('tick', async () => runners.tick());
await boss.work('cleanup', async () => runners.cleanup());
await boss.work('telescope-cleanup', async () => runners['telescope-cleanup']());

// Deliveries: woken by NOTIFY from notify(), with a periodic sweep for retries.
const deliver = () => runners.deliver();
await sql.listen(DELIVERY_CHANNEL, () => void deliver());
setInterval(deliver, 30_000);

// Integration polling: live-ish loop (connections carry their own next_poll_at),
// plus immediate polls requested by the web app ("Refresh" / just connected).
const poll = () => runners.poll();
await sql.listen(
	POLL_CHANNEL,
	(id) => void pollDue(1, id).catch((e) => console.error('[poll]', e))
);
setInterval(poll, 15_000);

// "Run now" from the admin panel.
await sql.listen(RUN_JOB_CHANNEL, (name) => {
	if (isJobName(name)) void runners[name]('manual');
});
const stopHeartbeat = startHeartbeat('worker');

void deliver();
void poll();
void runners.tick();
console.log('[worker] running: tick (1m), deliveries, integration polling (15s)');

const shutdown = async () => {
	stopHeartbeat();
	await boss.stop({ graceful: true, timeout: 10_000 });
	await sql.end({ timeout: 5 });
	process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
