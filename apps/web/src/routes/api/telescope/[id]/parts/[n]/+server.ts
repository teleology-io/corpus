import { z } from 'zod';
import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { partTarget } from '#lib/server/telescope.js';

/** Returns the URL to PUT part `n` to (presigned R2, or the local chunk route). */
export const POST: RequestHandler = async ({ locals, request, params }) => {
	const ctx = requireCtx(locals);
	const { size } = await body(request, z.object({ size: z.number().int() }));
	return Response.json(await partTarget(ctx, params.id, Number(params.n), size));
};
