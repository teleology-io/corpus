import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { requireVideo, serveObject } from '#lib/server/telescope.js';

export const GET: RequestHandler = async ({ locals, request, params }) => {
	const v = await requireVideo(requireCtx(locals), params.id);
	if (v.status !== 'ready') error(404, 'Not found');
	return serveObject(request, v.fileKey, v.mime);
};
