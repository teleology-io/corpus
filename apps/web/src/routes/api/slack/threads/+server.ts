import { z } from 'zod';
import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { followLink, listThreads } from '#lib/server/slack.js';

export const GET: RequestHandler = async ({ locals }) =>
	Response.json(await listThreads(requireCtx(locals).userId));

/** Follow a thread by pasting its Slack link. */
export const POST: RequestHandler = async ({ locals, request }) => {
	const ctx = requireCtx(locals);
	const { link } = await body(request, z.object({ link: z.string().trim().min(1).max(2000) }));
	return Response.json({ id: await followLink(ctx.userId, link) }, { status: 201 });
};
