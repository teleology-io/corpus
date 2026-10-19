import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { doseInput, logDose } from '#lib/server/planner.js';

export const POST: RequestHandler = async ({ locals, request }) => {
	await logDose(requireCtx(locals), await body(request, doseInput));
	return new Response(null, { status: 204 });
};
