import type { SearchResult } from '#lib/types.js';
import { searchRank } from './search-matching.js';
import type { Ctx } from './ctx.js';

/** Providers must scope reads to ctx permissions and apply every query term across searchable fields.
 * Return at most limit results, best first, with a usable destination and display-ready text.
 * Keep source-specific indexes and retrieval behind this interface.
 */
export interface SearchRequest {
	ctx: Ctx;
	query: string;
	terms: readonly string[];
	limit: number;
	signal?: AbortSignal;
	onFailure?: (id: string) => void;
}

export interface SearchProvider {
	/** Stable identifier, independent of the labels displayed on individual results. */
	id: string;
	search(request: SearchRequest): Promise<SearchResult[]> | SearchResult[];
}

/** Isolate synchronous and asynchronous failures and interleave sources before the palette cap. */
export async function runSearchProviders(
	providers: readonly SearchProvider[],
	request: SearchRequest
): Promise<SearchResult[]> {
	if (new Set(providers.map((p) => p.id)).size !== providers.length)
		throw new Error('Duplicate search provider id');
	if (!request.terms.length) return [];
	const groups = await Promise.all(
		providers.map(async (provider) => {
			try {
				request.signal?.throwIfAborted();
				return (await provider.search(request))
					.sort((a, b) => searchRank(request.query, a.title) - searchRank(request.query, b.title))
					.slice(0, request.limit);
			} catch (error) {
				if (request.signal?.aborted) throw request.signal.reason;
				request.onFailure?.(provider.id);
				console.error(`Search provider failed: ${provider.id}`, error);
				return [];
			}
		})
	);
	const results: SearchResult[] = [];
	for (let i = 0; i < request.limit; i++)
		for (const group of groups) if (group[i]) results.push(group[i]);
	request.signal?.throwIfAborted();
	return results.sort(
		(a, b) => searchRank(request.query, a.title) - searchRank(request.query, b.title)
	);
}
