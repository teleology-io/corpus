/**
 * Runs in each worker before the test file is imported. `@corpus/db` opens its pool on
 * DATABASE_URL at import time, and the repo `.env` loader never overrides variables already
 * set — so pointing DATABASE_URL at the disposable database here is sufficient. Must not
 * import `@corpus/db` itself.
 */
import { inject } from 'vitest';
import { assertTestUrl } from '@corpus/db/testing';

const testDb = inject('testDb');
assertTestUrl(testDb?.url);
process.env.DATABASE_URL = testDb.url;
process.env.CORPUS_TEST_RUN_ID = testDb.runId;
