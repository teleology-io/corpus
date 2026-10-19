import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { getPrefs, prefsInput, savePrefs } from '#lib/server/notifications.js';

export const GET: RequestHandler = async ({ locals }) =>
	Response.json(await getPrefs(requireCtx(locals).userId));

export const PUT: RequestHandler = async ({ locals, request }) => {
	const ctx = requireCtx(locals);
	await savePrefs(ctx.userId, await body(request, prefsInput));
	return new Response(null, { status: 204 });
};
