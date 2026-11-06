import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { applyAutoTitle, videoPatch } from '#lib/server/telescope.js';

export const POST: RequestHandler = async ({ locals, request, params }) => {
	const ctx = requireCtx(locals);
	return Response.json(await applyAutoTitle(ctx, params.id, await body(request, videoPatch)));
};
