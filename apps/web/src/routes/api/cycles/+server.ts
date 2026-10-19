import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { createCycle, cycleInput } from '#lib/server/planner.js';

export const POST: RequestHandler = async ({ locals, request }) => {
	const row = await createCycle(requireCtx(locals), await body(request, cycleInput));
	return Response.json({ id: row.id }, { status: 201 });
};
