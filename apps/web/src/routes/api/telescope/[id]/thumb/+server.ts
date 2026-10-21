import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { putThumb, requireVideo, serveObject } from '#lib/server/telescope.js';

export const GET: RequestHandler = async ({ locals, request, params }) => {
	const v = await requireVideo(requireCtx(locals), params.id);
	if (!v.thumbKey) error(404, 'Not found');
	return serveObject(request, v.thumbKey, 'image/jpeg');
};

export const PUT: RequestHandler = async ({ locals, request, params }) => {
	await putThumb(requireCtx(locals), params.id, request);
	return new Response(null, { status: 204 });
};
