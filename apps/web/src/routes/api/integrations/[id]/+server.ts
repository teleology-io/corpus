import { z } from 'zod';
import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { disconnect, updateConnectionSettings } from '#lib/server/integrations.js';

export const PATCH: RequestHandler = async ({ locals, request, params }) => {
	const ctx = requireCtx(locals);
	const settings = await body(
		request,
		z.object({
			syncTasks: z.boolean().optional(),
			notify: z.boolean().optional(),
			calendars: z.array(z.string().max(300)).max(50).optional()
		})
	);
	await updateConnectionSettings(ctx.userId, params.id, settings);
	return new Response(null, { status: 204 });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	await disconnect(requireCtx(locals).userId, params.id);
	return new Response(null, { status: 204 });
};
