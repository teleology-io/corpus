import { defineConfig } from 'vitest/config';

/**
 * Two projects:
 *  - `unit`: pure tests under test/unit — no database, no global setup.
 *  - `db`: server-side integration tests against a disposable Postgres database (no SvelteKit
 *    plugin — the code under test doesn't use `$app/*`). `test/global-setup.ts` creates and
 *    migrates the database, then hands its URL to workers via `provide`;
 *    `test/worker-setup.ts` sets DATABASE_URL from it before any test file imports `@corpus/db`.
 *
 * `vitest run --project unit` needs no database.
 */
export default defineConfig({
	test: {
		environment: 'node',
		projects: [
			{
				extends: true,
				test: { name: 'unit', include: ['test/unit/**/*.test.ts'] }
			},
			{
				extends: true,
				test: {
					name: 'db',
					include: ['test/**/*.test.ts'],
					exclude: ['test/unit/**'],
					globalSetup: ['./test/global-setup.ts'],
					setupFiles: ['./test/worker-setup.ts'],
					// One shared database: run files and tests serially.
					fileParallelism: false,
					sequence: { concurrent: false },
					testTimeout: 15_000,
					hookTimeout: 60_000
				}
			}
		]
	}
});
