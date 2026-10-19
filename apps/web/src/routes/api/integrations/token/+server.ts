import { z } from 'zod';
import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { connectWithToken } from '#lib/server/integrations.js';

export const POST: RequestHandler = async ({ locals, request }) => {
	const ctx = requireCtx(locals);
	const { provider, token } = await body(
		request,
		z.object({ provider: z.string().max(50), token: z.string().trim().min(8).max(500) })
	);
	await connectWithToken(ctx.userId, provider, token);
	return new Response(null, { status: 204 });
};
