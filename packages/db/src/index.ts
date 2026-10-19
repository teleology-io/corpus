import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';
import { env } from './env';

export { env, optionalEnv, loadEnv } from './env';
export * as schema from './schema/index';
export * from './schema/index';

const globalForDb = globalThis as unknown as { __corpusSql?: postgres.Sql };

export const sql = (globalForDb.__corpusSql ??= postgres(env('DATABASE_URL'), { max: 10 }));
export const db = drizzle(sql, { schema, casing: 'snake_case' });
export type DB = typeof db;

/** Publish a realtime event to a user's channel (consumed by the web SSE stream). */
export async function publish(userId: string, event: { type: string; [k: string]: unknown }) {
	await sql.notify(`user_${userId.replace(/[^a-zA-Z0-9_]/g, '_')}`, JSON.stringify(event));
}

export function userChannel(userId: string) {
	return `user_${userId.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}
