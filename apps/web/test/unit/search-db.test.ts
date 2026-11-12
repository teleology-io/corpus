import { expect, it, vi } from 'vitest';

const driver = vi.hoisted(() => {
	const pending: {
		cancel: ReturnType<typeof vi.fn>;
		resolve: (rows: unknown[][]) => void;
		reject: (error: Error) => void;
		values: ReturnType<typeof vi.fn>;
	}[] = [];
	const client = Object.assign(() => {}, {
		options: { parsers: {}, serializers: {} },
		unsafe: vi.fn(() => {
			let resolve!: (rows: unknown[][]) => void, reject!: (error: Error) => void;
			const query = Object.assign(
				new Promise<unknown[][]>((yes, no) => {
					resolve = yes;
					reject = no;
				}),
				{ values: vi.fn().mockReturnThis(), cancel: vi.fn(() => reject(new Error('cancelled'))) }
			);
			pending.push({ ...query, cancel: query.cancel, values: query.values, resolve, reject });
			return query;
		})
	});
	return { client, pending };
});

vi.mock('@corpus/db', async () => {
	const { drizzle } = await import('drizzle-orm/postgres-js');
	return { sql: driver.client, schema: {}, db: drizzle(driver.client as never) };
});

import { searchDb } from '../../src/lib/server/search-db.js';
import { pgTable, text } from 'drizzle-orm/pg-core';

it('preserves Drizzle field mapping and cancels only the request-local pending query', async () => {
	const table = pgTable('sample', { title: text('title') });
	const first = new AbortController(),
		second = new AbortController();
	const a = searchDb(first.signal).select({ title: table.title }).from(table).execute();
	const b = searchDb(second.signal).select({ title: table.title }).from(table).execute();
	expect(driver.pending).toHaveLength(2);
	expect(driver.pending[0].values).toHaveBeenCalledOnce();
	first.abort();
	await expect(a).rejects.toThrow();
	expect(driver.pending[1].cancel).not.toHaveBeenCalled();
	driver.pending[1].resolve([['Mapped title']]);
	await expect(b).resolves.toEqual([{ title: 'Mapped title' }]);
	second.abort();
	expect(driver.pending[1].cancel).not.toHaveBeenCalled();
});
