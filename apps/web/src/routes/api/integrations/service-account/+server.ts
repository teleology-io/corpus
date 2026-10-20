import { z } from 'zod';
import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { connectServiceAccount } from '#lib/server/integrations.js';

export const POST: RequestHandler = async ({ locals, request }) => {
	const ctx = requireCtx(locals);
	const { credentials, subject } = await body(
		request,
		z.object({
			credentials: z.string().trim().min(20).max(10_000),
			subject: z.email().max(320).nullish().or(z.literal(''))
		})
	);
	await connectServiceAccount(ctx.userId, credentials, subject);
	return new Response(null, { status: 204 });
};
