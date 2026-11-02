import type { TestProject } from 'vitest/node';
import { createTestDatabase, dropTestDatabase, type TestDatabase } from '@corpus/db/testing';

declare module 'vitest' {
	export interface ProvidedContext {
		testDb: TestDatabase;
	}
}

/** Runs once in the main process: create + migrate a fresh corpus_test_* database. */
export default async function setup(project: TestProject) {
	const testDb = await createTestDatabase();
	project.provide('testDb', testDb);
	return async () => {
		await dropTestDatabase(testDb);
	};
}
