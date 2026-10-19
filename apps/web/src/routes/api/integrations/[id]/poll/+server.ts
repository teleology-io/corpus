import type { RequestHandler } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { ownConnection, requestPoll } from '#lib/server/integrations.js';

export const POST: RequestHandler = async ({ locals, params }) => {
	const ctx = requireCtx(locals);
	await ownConnection(ctx.userId, params.id);
	await requestPoll(params.id);
	return new Response(null, { status: 202 });
};
