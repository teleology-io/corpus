import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { categoryInput, createCategory } from '#lib/server/calendar.js';

export const POST: RequestHandler = async ({ locals, request }) => {
	const row = await createCategory(requireCtx(locals), await body(request, categoryInput));
	return Response.json({ id: row.id }, { status: 201 });
};
