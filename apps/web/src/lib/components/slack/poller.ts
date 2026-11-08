/**
 * Polls `tick` on a self-scheduling timer: the next poll is only scheduled after the previous one
 * settles (never overlapping), pauses while the tab is hidden, and catches up when it's visible.
 * `tick` may return seconds to wait instead of the default (Slack's Retry-After, slow mode).
 */
export function startPoller(tick: () => Promise<number | null | void>, everyMs: number) {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let running = false;
	let stopped = false;
	let failures = 0;

	const schedule = (ms: number) => {
		if (stopped) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(run, ms);
	};

	async function run() {
		timer = null;
		if (stopped || running) return;
		if (document.hidden) return; // resumes on visibilitychange
		running = true;
		let waitMs = everyMs;
		try {
			const sec = await tick();
			failures = 0;
			if (sec) waitMs = Math.max(everyMs, sec * 1000);
		} catch {
			// Exponential backoff on network / server errors: 20 s, 40 s… up to 5 min.
			failures++;
			waitMs = Math.min(everyMs * 2 ** failures, 300_000);
		} finally {
			running = false;
		}
		schedule(waitMs);
	}

	const onVisible = () => {
		if (!document.hidden && !running) schedule(0);
	};
	document.addEventListener('visibilitychange', onVisible);
	schedule(everyMs);

	return {
		/** Poll now (manual refresh); resets the timer. */
		now: () => schedule(0),
		stop() {
			stopped = true;
			if (timer) clearTimeout(timer);
			document.removeEventListener('visibilitychange', onVisible);
		}
	};
}
