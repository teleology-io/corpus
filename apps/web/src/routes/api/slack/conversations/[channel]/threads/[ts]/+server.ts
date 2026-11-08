import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { getThread } from '#lib/server/slack-connector.js';

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!/^[CDG][A-Z0-9]{2,30}$/.test(params.channel)) error(400, 'Bad conversation id');
	if (!/^\d{9,11}\.\d{1,6}$/.test(params.ts)) error(400, 'Bad timestamp');
	return Response.json(await getThread(requireCtx(locals).userId, params.channel, params.ts));
};
