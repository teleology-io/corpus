/**
 * Guards on the disposable-database helpers. Pure: none of these open a connection, so a
 * rejected URL can never reach a server.
 */
import { describe, expect, it } from 'vitest';
import { assertDropTarget, assertTestUrl, resolveAdminUrl } from '@corpus/db/testing';

const TEST = 'postgres://corpus:corpus@localhost:5431/corpus_test_abc_1_ff';

describe('resolveAdminUrl', () => {
	it('defaults to the postgres db on the same server', () => {
		expect(resolveAdminUrl(TEST)).toBe('postgres://corpus:corpus@localhost:5431/postgres');
	});

	it('accepts an override on the same host and port', () => {
		const admin = 'postgres://su:pw@localhost:5431/template1';
		expect(resolveAdminUrl(TEST, admin)).toBe(admin);
	});

	it.each([
		['remote host', 'postgres://corpus:corpus@db.example.com:5431/postgres', /non-local admin/],
		['different port', 'postgres://corpus:corpus@localhost:5432/postgres', /same server/],
		['implicit default port', 'postgres://corpus:corpus@localhost/postgres', /same server/],
		[
			'different local host spelling',
			'postgres://corpus:corpus@127.0.0.1:5431/postgres',
			/same server/
		],
		['a test database', 'postgres://corpus:corpus@localhost:5431/corpus_test_other', /maintenance/],
		['no database', 'postgres://corpus:corpus@localhost:5431/', /maintenance/]
	])('rejects an override with %s', (_case, admin, message) => {
		expect(() => resolveAdminUrl(TEST, admin)).toThrow(message);
	});

	it('rejects a non-local test URL even without an override', () => {
		expect(() => resolveAdminUrl('postgres://u:p@db.example.com:5431/corpus_test_x')).toThrow(
			/non-local test/
		);
	});
});

describe('assertDropTarget', () => {
	const ok = { url: TEST, name: 'corpus_test_abc_1_ff', runId: 'abc_1_ff' };

	it('accepts the matching record', () => {
		expect(() => assertDropTarget(ok)).not.toThrow();
	});

	it.each([
		['name not in the URL', { ...ok, name: 'corpus_test_other' }, /does not match the test URL/],
		['name not a test db', { ...ok, name: 'corpus' }, /does not match the test URL/],
		['run id mismatch', { ...ok, runId: 'zzz' }, /run id/],
		['empty run id', { ...ok, runId: '' }, /run id/],
		[
			'URL is the app db',
			{ ...ok, url: 'postgres://u:p@localhost:5431/corpus' },
			/not a corpus_test_/
		],
		[
			'remote URL',
			{ ...ok, url: 'postgres://u:p@db.example.com:5431/corpus_test_abc_1_ff' },
			/non-local/
		]
	])('rejects %s', (_case, record, message) => {
		expect(() => assertDropTarget(record)).toThrow(message);
	});
});

describe('assertTestUrl', () => {
	it.each([
		[undefined, /not set/],
		['postgres://u:p@localhost:5431/corpus', /not a corpus_test_/],
		['postgres://u:p@10.0.0.5:5431/corpus_test_x', /non-local/]
	])('rejects %s', (url, message) => {
		expect(() => assertTestUrl(url)).toThrow(message);
	});
});
