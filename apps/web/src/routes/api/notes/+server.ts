import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { createNote, noteCreate } from '#lib/server/notes.js';

export const POST: RequestHandler = async ({ locals, request }) => {
	const row = await createNote(requireCtx(locals), await body(request, noteCreate));
	return Response.json({ id: row.id }, { status: 201 });
};
