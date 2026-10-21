import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { completeInput, completeVideo } from '#lib/server/telescope.js';

export const POST: RequestHandler = async ({ locals, request, params }) => {
	const ctx = requireCtx(locals);
	return Response.json(await completeVideo(ctx, params.id, await body(request, completeInput)));
};
