import type { RequestHandler } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { refresh } from '#lib/server/slack-connector.js';

/** Manual refresh: re-sync the conversation list now and poll mentions/threads. */
export const POST: RequestHandler = async ({ locals }) =>
	Response.json(await refresh(requireCtx(locals).userId));
