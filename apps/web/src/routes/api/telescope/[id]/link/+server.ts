import { z } from 'zod';
import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { setLink } from '#lib/server/telescope.js';

/** Turn "anyone with the link" on; `reset: true` replaces the URL so the old one stops working. */
export const POST: RequestHandler = async ({ locals, request, params, url }) => {
	const ctx = requireCtx(locals);
	const { reset } = await body(request, z.object({ reset: z.boolean().default(false) }));
	const res = await setLink(ctx, params.id, true, reset);
	return Response.json({ ...res, url: `${url.origin}/v/${res.linkToken}` });
};

/** Back to private. The token is kept so turning the link on again restores the same URL. */
export const DELETE: RequestHandler = async ({ locals, params }) => {
	await setLink(requireCtx(locals), params.id, false);
	return new Response(null, { status: 204 });
};
