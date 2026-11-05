import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '@corpus/db/env';
import { hostEnv } from '../src/lib/server/wrx/core.js';
import { Postgres, parseConfig } from '../src/lib/server/wrx/provision.js';

// Runs psql inside this repository's Compose Postgres, against the disposable test server.
const composeRoot = fileURLToPath(new URL('../../..', import.meta.url));
loadEnv();
const server = new URL(process.env.TEST_DATABASE_URL ?? '');

describe('per-worktree databases', () => {
	const run = randomBytes(4).toString('hex');
	const sourceName = `wb_source_${run}`;
	const base = `wb_base_${run}`;
	const clone = `wb_${run}`;
	const snapshot = `wb_${run}_s_1`;
	const all = [sourceName, base, `${base}_new`, clone, snapshot];
	const url = new URL(server);
	url.pathname = `/${sourceName}`;
	const config = parseConfig(
		JSON.stringify({
			database: {
				engine: 'postgres',
				source: url.toString(),
				service: 'postgres',
				excludeData: ['secrets']
			}
		})
	);
	const pg = new Postgres(config, composeRoot, { env: hostEnv() });
	const admin = (statement: string) => pg.sql(statement, 'postgres');
	const rows = (statement: string, database: string) => pg.sql(statement, database);

	beforeAll(async () => {
		await admin(`create database ${sourceName}`);
		await rows(
			`create table notes (body text); insert into notes values ('from source');
			 create table secrets (token text); insert into secrets values ('real token');`,
			sourceName
		);
	});

	afterAll(async () => {
		for (const name of all) await admin(`drop database if exists ${name} with (force)`);
	});

	it('builds a template without data from excluded tables', async () => {
		await pg.buildBase(base);
		expect(await pg.exists(base)).toBe(true);
		expect(await pg.exists(`${base}_new`)).toBe(false);
		await pg.clone(base, clone);
		expect(await rows('select body from notes', clone)).toBe('from source');
		expect(await rows('select count(*) from secrets', clone)).toBe('0');
	});

	it('keeps the template closed to connections', async () => {
		await expect(rows('select 1', base)).rejects.toThrow(
			/not accepting connections|not currently accepting/
		);
	});

	it('restores a snapshot without touching the source', async () => {
		await pg.cloneLive(clone, snapshot);
		await pg.allowConnections(snapshot, false);
		await rows(`insert into notes values ('after snapshot')`, clone);
		expect(await rows('select count(*) from notes', clone)).toBe('2');

		await pg.drop(clone);
		await pg.clone(snapshot, clone);
		expect(await rows('select count(*) from notes', clone)).toBe('1');
		expect(await rows('select count(*) from notes', sourceName)).toBe('1');
		expect(await rows('select count(*) from secrets', sourceName)).toBe('1');
	});

	it('lists only the databases a workspace owns', async () => {
		const owned = await pg.sql(
			`select datname from pg_database where datname ~ '^${clone}(_s_[0-9]+)?$' order by 1`
		);
		expect(owned.split('\n')).toEqual([clone, snapshot]);
	});
});
