import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { categoryInput, deleteCategory, updateCategory } from '#lib/server/calendar.js';

export const PATCH: RequestHandler = async ({ locals, request, params }) => {
	await updateCategory(requireCtx(locals), params.id, await body(request, categoryInput.partial()));
	return new Response(null, { status: 204 });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	await deleteCategory(requireCtx(locals), params.id);
	return new Response(null, { status: 204 });
};
