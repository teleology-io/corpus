import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { deleteVideo, updateVideo, videoDetail, videoPatch } from '#lib/server/telescope.js';

export const GET: RequestHandler = async ({ locals, params }) =>
	Response.json(await videoDetail(requireCtx(locals), params.id));

export const PATCH: RequestHandler = async ({ locals, request, params }) => {
	const ctx = requireCtx(locals);
	await updateVideo(ctx, params.id, await body(request, videoPatch));
	return new Response(null, { status: 204 });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	await deleteVideo(requireCtx(locals), params.id);
	return new Response(null, { status: 204 });
};
