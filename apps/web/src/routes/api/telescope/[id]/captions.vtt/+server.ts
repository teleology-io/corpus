import type { RequestHandler } from './$types';
import { toVtt } from '@corpus/core/telescope';
import { requireCtx } from '#lib/server/ctx.js';
import { requireVideo } from '#lib/server/telescope.js';

export const GET: RequestHandler = async ({ locals, params }) => {
	const v = await requireVideo(requireCtx(locals), params.id);
	return new Response(toVtt(v.transcript ?? []), {
		headers: { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' }
	});
};
