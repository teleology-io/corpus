import type { RequestHandler } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { clearCache } from '#lib/server/slack-connector.js';

/** Delete every cached Slack conversation, message and user name (followed threads stay). */
export const DELETE: RequestHandler = async ({ locals }) => {
	await clearCache(requireCtx(locals).userId);
	return new Response(null, { status: 204 });
};
