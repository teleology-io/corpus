import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { createDraft, draftInput, listVideos } from '#lib/server/telescope.js';

export const GET: RequestHandler = async ({ locals }) =>
	Response.json(await listVideos(requireCtx(locals)));

/** Starts a recording upload; the recorder then streams parts and calls complete. */
export const POST: RequestHandler = async ({ locals, request }) => {
	const ctx = requireCtx(locals);
	return Response.json(await createDraft(ctx, await body(request, draftInput)), { status: 201 });
};
