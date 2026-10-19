import { z } from 'zod';
import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { cycleInput, deleteCycle, updateCycle } from '#lib/server/planner.js';

const patch = cycleInput.partial().extend({ paused: z.boolean().optional() });

export const PATCH: RequestHandler = async ({ locals, request, params }) => {
	const row = await updateCycle(requireCtx(locals), params.id, await body(request, patch));
	return Response.json({ id: row.id });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	await deleteCycle(requireCtx(locals), params.id);
	return new Response(null, { status: 204 });
};
