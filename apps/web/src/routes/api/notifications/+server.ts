import { z } from 'zod';
import type { RequestHandler } from './$types';
import { markRead } from '@corpus/db/notify';
import { body, requireCtx } from '#lib/server/ctx.js';
import { listNotifications, unreadCount } from '#lib/server/notifications.js';

export const GET: RequestHandler = async ({ locals }) => {
	const ctx = requireCtx(locals);
	const [items, unread] = await Promise.all([
		listNotifications(ctx.userId, 50),
		unreadCount(ctx.userId)
	]);
	return Response.json({ items, unread });
};

/** Mark read: { ids?: string[] } — omit ids to mark everything read. */
export const POST: RequestHandler = async ({ locals, request }) => {
	const ctx = requireCtx(locals);
	const { ids } = await body(request, z.object({ ids: z.array(z.uuid()).optional() }));
	await markRead(ctx.userId, ids);
	return new Response(null, { status: 204 });
};
