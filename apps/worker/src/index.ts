import { PgBoss } from 'pg-boss';
import { env, sql } from '@corpus/db';
import { DELIVERY_CHANNEL } from '@corpus/db/notify';
import { tick } from './scheduler';
import { cleanup, deliverPending } from './delivery';
import { pollDue } from './integrations';

const POLL_CHANNEL = 'corpus_poll';

/** Serialize a recurring async job so overlapping triggers coalesce into one extra run. */
function serial(name: string, fn: () => Promise<unknown>) {
	let running = false;
	let again = false;
	const run = async (): Promise<void> => {
		if (running) {
			again = true;
			return;
		}
		running = true;
		try {
			await fn();
		} catch (e) {
			console.error(`[${name}]`, e);
		} finally {
			running = false;
			if (again) {
				again = false;
				void run();
			}
		}
	};
	return run;
}

const boss = new PgBoss(env('DATABASE_URL'));
boss.on('error', (e) => console.error('[pg-boss]', e));
await boss.start();

// Cron-driven jobs: pg-boss guarantees one run per minute across all worker instances.
for (const q of ['tick', 'cleanup']) await boss.createQueue(q);
await boss.schedule('tick', '* * * * *');
await boss.schedule('cleanup', '17 3 * * *');
await boss.work('tick', async () => tick());
await boss.work('cleanup', async () => cleanup());

// Deliveries: woken by NOTIFY from notify(), with a periodic sweep for retries.
const deliver = serial('deliver', deliverPending);
await sql.listen(DELIVERY_CHANNEL, () => void deliver());
setInterval(deliver, 30_000);

// Integration polling: live-ish loop (connections carry their own next_poll_at),
// plus immediate polls requested by the web app ("Refresh" / just connected).
const poll = serial('poll', () => pollDue());
await sql.listen(
	POLL_CHANNEL,
	(id) => void pollDue(1, id).catch((e) => console.error('[poll]', e))
);
setInterval(poll, 15_000);

void deliver();
void poll();
void tick();
console.log('[worker] running: tick (1m), deliveries, integration polling (15s)');

const shutdown = async () => {
	await boss.stop({ graceful: true, timeout: 10_000 });
	await sql.end({ timeout: 5 });
	process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
