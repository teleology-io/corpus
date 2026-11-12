import { describe, expect, it, vi } from 'vitest';
import { bindSearchAbort } from '../../src/lib/server/search-abort.js';

function pending() {
	let resolve!: () => void;
	let reject!: (e: Error) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { query: Object.assign(promise, { cancel: vi.fn() }), resolve, reject };
}

describe('search query cancellation', () => {
	it('cancels only queries belonging to the aborted request', async () => {
		const a = new AbortController(),
			b = new AbortController();
		const first = pending(),
			second = pending();
		bindSearchAbort(first.query, a.signal);
		bindSearchAbort(second.query, b.signal);
		a.abort();
		expect(first.query.cancel).toHaveBeenCalledOnce();
		expect(second.query.cancel).not.toHaveBeenCalled();
		first.resolve();
		second.resolve();
		await Promise.all([first.query, second.query]);
	});

	it.each(['resolve', 'reject'] as const)('removes listeners after %s', async (outcome) => {
		const controller = new AbortController();
		const query = pending();
		bindSearchAbort(query.query, controller.signal);
		if (outcome === 'resolve') query.resolve();
		else query.reject(new Error('failed'));
		await query.query.catch(() => {});
		controller.abort();
		expect(query.query.cancel).not.toHaveBeenCalled();
	});

	it('cancels when the signal was already aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		const query = pending();
		bindSearchAbort(query.query, controller.signal);
		expect(query.query.cancel).toHaveBeenCalledOnce();
		query.resolve();
		await query.query;
	});
});
