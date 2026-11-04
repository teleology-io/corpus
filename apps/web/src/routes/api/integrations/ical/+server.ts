import { z } from 'zod';
import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { connectIcal } from '#lib/server/integrations.js';

/** Connects Google Calendar via a secret iCal address, or adds another one. */
export const POST: RequestHandler = async ({ locals, request }) => {
	const ctx = requireCtx(locals);
	const { url } = await body(request, z.object({ url: z.string().trim().min(10).max(2000) }));
	await connectIcal(ctx.userId, url);
	return new Response(null, { status: 204 });
};
