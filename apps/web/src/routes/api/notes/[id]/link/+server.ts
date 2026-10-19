import { z } from 'zod';
import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { createLink, revokeLink } from '#lib/server/notes.js';

export const POST: RequestHandler = async ({ locals, request, params, url }) => {
	const { role } = await body(
		request,
		z.object({ role: z.enum(['view', 'comment', 'edit']).default('view') })
	);
	const link = await createLink(requireCtx(locals), params.id, role);
	return Response.json({ url: `${url.origin}/share/${link.token}`, role: link.role });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	await revokeLink(requireCtx(locals), params.id);
	return new Response(null, { status: 204 });
};
