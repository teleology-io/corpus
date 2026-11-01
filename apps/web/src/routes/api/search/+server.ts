import type { RequestHandler } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { searchAll } from '#lib/server/search.js';

/** App-wide search for the ⌘K palette. */
export const GET: RequestHandler = async ({ locals, url }) => {
	const q = url.searchParams.get('q')?.trim().slice(0, 200) ?? '';
	return Response.json(q ? await searchAll(requireCtx(locals), q) : []);
};
