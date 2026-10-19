import { z } from 'zod';
import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { reply } from '#lib/server/slack.js';

export const POST: RequestHandler = async ({ locals, request, params }) => {
	const ctx = requireCtx(locals);
	const { text } = await body(request, z.object({ text: z.string().trim().min(1).max(4000) }));
	return Response.json({ ts: await reply(ctx.userId, params.id, text) }, { status: 201 });
};
