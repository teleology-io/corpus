import { describe, expect, it, vi } from 'vitest';
import { runSearchProviders, type SearchRequest } from '../../src/lib/server/search-provider.js';
import { matcher, sqlMatcher, termsOf } from '../../src/lib/server/search-matching.js';
import { PgDialect, pgTable, text } from 'drizzle-orm/pg-core';

const request: SearchRequest = {
	ctx: {} as SearchRequest['ctx'],
	query: 'hello',
	terms: ['hello'],
	limit: 2
};
const row = (title: string) => ({ kind: 'Test', title, detail: '', href: '/test' });

describe('global search providers', () => {
	it('passes the common request and preserves source order while interleaving and limiting', async () => {
		const search = vi.fn(() => [row('a1'), row('a2'), row('a3')]);
		const results = await runSearchProviders(
			[
				{ id: 'a', search },
				{ id: 'b', search: async () => [row('b1'), row('b2')] }
			],
			request
		);
		expect(search).toHaveBeenCalledWith(request);
		expect(results.map((r) => r.title)).toEqual(['a1', 'b1', 'a2', 'b2']);
	});

	it('keeps healthy results when synchronous and asynchronous sources fail', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const results = await runSearchProviders(
				[
					{
						id: 'sync',
						search: () => {
							throw new Error('sync');
						}
					},
					{
						id: 'async',
						search: async () => {
							throw new Error('async');
						}
					},
					{ id: 'healthy', search: () => [row('ok')] }
				],
				request
			);
			expect(results).toEqual([row('ok')]);
			expect(log).toHaveBeenCalledTimes(2);
		} finally {
			log.mockRestore();
		}
	});

	it('rejects duplicate registrations and skips blank searches', async () => {
		const provider = { id: 'same', search: vi.fn(() => []) };
		await expect(runSearchProviders([provider, provider], request)).rejects.toThrow('Duplicate');
		expect(await runSearchProviders([provider], { ...request, terms: [] })).toEqual([]);
		expect(provider.search).not.toHaveBeenCalled();
	});
});

describe('shared matching rules', () => {
	it('requires all terms across fields regardless of case or spacing', () => {
		expect(termsOf(' Alpha  BETA ')).toEqual(['alpha', 'beta']);
		expect(matcher('Alpha beta')('BETA', null, 'alpha')).toBe(true);
		expect(matcher('Alpha beta')('alpha')).toBe(false);
		expect(matcher('100% _')('100% complete', '_')).toBe(true);
	});

	it('escapes SQL wildcards and uses a predicate for every term', () => {
		const table = pgTable('search_test', { title: text('title') });
		const expression = sqlMatcher('100% a_b c\\d')(table.title);
		const query = new PgDialect().sqlToQuery(expression!);
		expect(query.params).toEqual(['%100\\%%', '%a\\_b%', '%c\\\\d%']);
		expect(query.sql.match(/ilike/g)).toHaveLength(3);
	});
});

describe('search relevance and partial failures', () => {
	it('ranks exact titles above prefix, all-title-term and body matches across sources', async () => {
		const results = await runSearchProviders(
			[
				{ id: 'body', search: () => [row('Unrelated title')] },
				{ id: 'prefix', search: () => [row('hello world')] },
				{ id: 'exact', search: () => [row('hello')] }
			],
			request
		);
		expect(results.map((r) => r.title)).toEqual(['hello', 'hello world', 'Unrelated title']);
	});

	it('reports failed sources while retaining healthy results', async () => {
		const onFailure = vi.fn();
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await runSearchProviders(
				[
					{
						id: 'broken',
						search: () => {
							throw new Error('failed');
						}
					}
				],
				{ ...request, onFailure }
			);
			expect(onFailure).toHaveBeenCalledWith('broken');
		} finally {
			log.mockRestore();
		}
	});

	it('does not run or report sources after cancellation', async () => {
		const signal = AbortSignal.abort();
		const onFailure = vi.fn();
		const search = vi.fn(() => []);
		await expect(
			runSearchProviders([{ id: 'skip', search }], { ...request, signal, onFailure })
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(search).not.toHaveBeenCalled();
		expect(onFailure).not.toHaveBeenCalled();
	});
});
