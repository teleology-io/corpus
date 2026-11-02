/**
 * Disposable Postgres databases for integration tests.
 *
 * Deliberately does NOT import `./index` (which opens a pool on DATABASE_URL at import time):
 * Vitest's global setup calls `createTestDatabase()` in the main process, hands the URL to
 * workers via `provide`/`inject`, and workers set DATABASE_URL before importing `@corpus/db`.
 */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { loadEnv } from './env';

export const TEST_DB_PREFIX = 'corpus_test_';
const NAME = /^corpus_test_[a-z0-9_]+$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const MARKER = '__corpus_test';

export interface TestDatabase {
	url: string;
	name: string;
	runId: string;
}

function parse(url: string) {
	const u = new URL(url);
	return { u, name: decodeURIComponent(u.pathname.replace(/^\//, '')) };
}

function withDatabase(url: string, name: string) {
	const u = new URL(url);
	u.pathname = `/${name}`;
	return u.toString();
}

/** Throws unless `url` names a local `corpus_test_*` database. */
export function assertTestUrl(url: string | undefined): asserts url is string {
	if (!url) throw new Error('Test database URL is not set');
	const { u, name } = parse(url);
	if (!LOCAL_HOSTS.has(u.hostname))
		throw new Error(`Refusing to use non-local test database host "${u.hostname}"`);
	if (!NAME.test(name)) throw new Error(`Refusing to use "${name}" — not a ${TEST_DB_PREFIX}* db`);
}

const portOf = (u: URL) => u.port || '5432';

/**
 * The maintenance connection used to CREATE/DROP test databases: TEST_DATABASE_ADMIN_URL if
 * given, else the test URL pointed at `postgres`. Pure — never connects. Throws unless it is
 * local, on the same host and port as `testUrl`, and not itself a test database (or the target).
 */
export function resolveAdminUrl(testUrl: string, adminOverride?: string): string {
	const test = parse(testUrl).u;
	if (!LOCAL_HOSTS.has(test.hostname))
		throw new Error(`Refusing non-local test database host "${test.hostname}"`);
	const admin = adminOverride ?? withDatabase(testUrl, 'postgres');
	const { u, name } = parse(admin);
	if (!LOCAL_HOSTS.has(u.hostname))
		throw new Error(`Refusing non-local admin database host "${u.hostname}"`);
	if (u.hostname !== test.hostname || portOf(u) !== portOf(test))
		throw new Error(
			`Admin URL (${u.hostname}:${portOf(u)}) must target the same server as the test ` +
				`database (${test.hostname}:${portOf(test)})`
		);
	if (!name || NAME.test(name))
		throw new Error(`Admin URL must name a maintenance database, not "${name || '(none)'}"`);
	return admin;
}

/**
 * Pure check before a force-drop: the name must be a test database, equal the database in
 * `url`, and carry this run's id — so a tampered or mismatched record can't drop anything else.
 */
export function assertDropTarget(t: TestDatabase) {
	assertTestUrl(t.url);
	if (parse(t.url).name !== t.name)
		throw new Error(`Refusing to drop "${t.name}" — does not match the test URL`);
	if (!t.runId || t.name !== `${TEST_DB_PREFIX}${t.runId}`)
		throw new Error(`Refusing to drop "${t.name}" — does not match run id "${t.runId}"`);
}

/**
 * Creates a fresh `corpus_test_<run>` database next to TEST_DATABASE_URL, migrates it and
 * stamps it with a marker row holding this run's id.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
	loadEnv();
	const base = process.env.TEST_DATABASE_URL;
	if (!base)
		throw new Error(
			'TEST_DATABASE_URL is not set — e.g. postgres://corpus:corpus@localhost:5431/corpus_test'
		);
	const { u } = parse(base);
	if (!LOCAL_HOSTS.has(u.hostname))
		throw new Error(`Refusing to create a test database on non-local host "${u.hostname}"`);
	const app = process.env.DATABASE_URL;
	if (app && parse(app).name === parse(base).name)
		throw new Error('TEST_DATABASE_URL must not point at the same database as DATABASE_URL');

	const runId = `${Date.now().toString(36)}_${process.pid}_${randomBytes(3).toString('hex')}`;
	const name = `${TEST_DB_PREFIX}${runId}`;
	const url = withDatabase(base, name);
	assertDropTarget({ url, name, runId });
	// Validated before any connection: local, same server/port as the test database.
	const adminUrl = resolveAdminUrl(url, process.env.TEST_DATABASE_ADMIN_URL);

	const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
	try {
		await admin.unsafe(`create database "${name}"`);
	} finally {
		await admin.end();
	}

	const client = postgres(url, { max: 1, onnotice: () => {} });
	try {
		await migrate(drizzle(client), {
			migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url))
		});
		await client.unsafe(`create table "${MARKER}" (run_id text not null)`);
		await client`insert into ${client(MARKER)} (run_id) values (${runId})`;
	} catch (e) {
		await client.end();
		await dropTestDatabase({ url, name, runId });
		throw e;
	}
	await client.end();
	return { url, name, runId };
}

export async function dropTestDatabase(t: TestDatabase) {
	assertDropTarget(t);
	const adminUrl = resolveAdminUrl(t.url, process.env.TEST_DATABASE_ADMIN_URL);
	const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
	try {
		await admin.unsafe(`drop database if exists "${t.name}" with (force)`);
	} finally {
		await admin.end();
	}
}

/**
 * Wipes test data, but only after proving the connection really is this run's disposable
 * database: the name matches and the marker row carries the expected run id. TRUNCATE ...
 * CASCADE from `user` and `organization` reaches every table that references them.
 */
export async function resetTestDatabase(sql: postgres.Sql, runId: string) {
	const [db] = await sql<{ name: string }[]>`select current_database() as name`;
	if (!db || !NAME.test(db.name))
		throw new Error(`Refusing to reset "${db?.name}" — not a ${TEST_DB_PREFIX}* db`);
	const marker = await sql<{ run_id: string }[]>`
		select run_id from ${sql(MARKER)} limit 1
	`.catch(() => []);
	if (marker[0]?.run_id !== runId)
		throw new Error(`Refusing to reset "${db.name}" — marker does not match this test run`);
	await sql.unsafe('truncate table "user", "organization" cascade');
}
