import { z } from 'zod';
import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { readThread, setFollowed } from '#lib/server/slack.js';

/** Messages straight from Slack; also marks the thread read. */
export const GET: RequestHandler = async ({ locals, params }) =>
	Response.json(await readThread(requireCtx(locals).userId, params.id));

export const PATCH: RequestHandler = async ({ locals, request, params }) => {
	const ctx = requireCtx(locals);
	const { followed } = await body(request, z.object({ followed: z.boolean() }));
	await setFollowed(ctx.userId, params.id, followed);
	return new Response(null, { status: 204 });
};
