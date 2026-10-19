import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { deleteNote, notePatch, updateNote } from '#lib/server/notes.js';

export const PATCH: RequestHandler = async ({ locals, request, params }) => {
	const row = await updateNote(requireCtx(locals), params.id, await body(request, notePatch));
	return Response.json({ id: row.id, title: row.title, icon: row.icon });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	await deleteNote(requireCtx(locals), params.id);
	return new Response(null, { status: 204 });
};
