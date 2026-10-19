import type { RequestHandler } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { searchNotes } from '#lib/server/notes.js';

export const GET: RequestHandler = async ({ locals, url }) => {
	const q = url.searchParams.get('q')?.trim() ?? '';
	return Response.json(q ? await searchNotes(requireCtx(locals), q) : []);
};
