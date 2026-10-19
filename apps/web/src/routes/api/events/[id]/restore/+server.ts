import type { RequestHandler } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { restoreEvent } from '#lib/server/calendar.js';

export const POST: RequestHandler = async ({ locals, params }) => {
	await restoreEvent(requireCtx(locals), params.id);
	return new Response(null, { status: 204 });
};
