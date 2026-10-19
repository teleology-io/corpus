import { z } from 'zod';
import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import {
	deletePushSubscription,
	pushInput,
	savePushSubscription
} from '#lib/server/notifications.js';

export const POST: RequestHandler = async ({ locals, request }) => {
	const ctx = requireCtx(locals);
	await savePushSubscription(
		ctx.userId,
		await body(request, pushInput),
		request.headers.get('user-agent')
	);
	return new Response(null, { status: 204 });
};

export const DELETE: RequestHandler = async ({ locals, request }) => {
	const ctx = requireCtx(locals);
	const { endpoint } = await body(request, z.object({ endpoint: z.string() }));
	await deletePushSubscription(ctx.userId, endpoint);
	return new Response(null, { status: 204 });
};
