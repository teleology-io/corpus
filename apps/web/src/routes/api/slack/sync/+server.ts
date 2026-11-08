import { z } from 'zod';
import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { startSync, stopSync } from '#lib/server/slack-connector.js';

/** Pause or resume background Slack polling. */
export const POST: RequestHandler = async ({ locals, request }) => {
	const ctx = requireCtx(locals);
	const { paused } = await body(request, z.object({ paused: z.boolean() }));
	await (paused ? stopSync(ctx.userId) : startSync(ctx.userId));
	return new Response(null, { status: 204 });
};
