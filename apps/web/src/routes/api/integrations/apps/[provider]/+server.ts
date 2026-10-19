import { error } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { getProvider } from '@corpus/core/integrations';
import { deleteOAuthApp, saveOAuthApp } from '@corpus/db/apps';
import { body, requireCtx } from '#lib/server/ctx.js';
import { requireAdmin } from '#lib/server/integrations.js';

/** Instance-wide OAuth app credentials (admin only). */
export const PUT: RequestHandler = async ({ locals, request, params }) => {
	const ctx = requireCtx(locals);
	await requireAdmin(ctx.user);
	if (!getProvider(params.provider)) error(404, 'Unknown integration');
	const creds = await body(
		request,
		z.object({
			clientId: z.string().trim().min(1).max(300),
			clientSecret: z.string().trim().min(1).max(500)
		})
	);
	await saveOAuthApp(params.provider, creds, ctx.userId);
	return new Response(null, { status: 204 });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	const ctx = requireCtx(locals);
	await requireAdmin(ctx.user);
	await deleteOAuthApp(params.provider);
	return new Response(null, { status: 204 });
};
