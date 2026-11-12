import { drizzle } from 'drizzle-orm/postgres-js';
import { db, sql, schema } from '@corpus/db';
import { bindSearchAbort } from './search-abort.js';

/** A request-local driver wrapper; each unsafe() call creates its own cancellable query. */
export function searchDb(signal?: AbortSignal): typeof db {
	if (!signal) return db;
	const client = new Proxy(sql, {
		get(target, key, receiver) {
			if (key !== 'unsafe') return Reflect.get(target, key, receiver);
			return (...args: Parameters<typeof sql.unsafe>) => {
				signal.throwIfAborted();
				return bindSearchAbort(target.unsafe(...args), signal);
			};
		}
	});
	return drizzle(client, { schema, casing: 'snake_case' });
}
