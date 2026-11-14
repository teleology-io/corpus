import { audit } from '#lib/server/queries.js';
import type { PageServerLoad } from './$types';

const FILTERS = [
	['job', 'Jobs'],
	['user', 'Users'],
	['connection', 'Integrations'],
	['superadmin', 'Access']
] as const;
const PAGE = 100;

export const load: PageServerLoad = async ({ url }) => {
	const raw = url.searchParams.get('action') ?? '';
	const action = FILTERS.some(([id]) => id === raw) ? raw : '';
	const beforeRaw = url.searchParams.get('before');
	const before = beforeRaw && !Number.isNaN(Date.parse(beforeRaw)) ? new Date(beforeRaw) : null;
	const rows = await audit(action ? `${action}.` : '', PAGE + 1, before);
	return {
		action,
		filters: FILTERS,
		before: before?.toISOString() ?? null,
		rows: rows.slice(0, PAGE),
		/** Cursor for the next page, when there is one. */
		older: rows.length > PAGE ? rows[PAGE - 1]!.createdAt.toISOString() : null
	};
};
