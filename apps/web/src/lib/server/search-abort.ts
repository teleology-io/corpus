/** Bind cancellation to one driver query, and remove the listener on either outcome.
 * postgres-js starts thenables in a microtask, so Drizzle can still select .values() synchronously.
 */
export function bindSearchAbort<T>(
	query: PromiseLike<T> & { cancel(): void },
	signal: AbortSignal
) {
	const cancel = () => query.cancel();
	signal.addEventListener('abort', cancel, { once: true });
	if (signal.aborted) cancel();
	const cleanup = () => signal.removeEventListener('abort', cancel);
	void query.then(cleanup, cleanup);
	return query;
}
