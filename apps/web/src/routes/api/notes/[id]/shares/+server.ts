import { z } from 'zod';
import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { addShare, listShares, removeShare, shareInput } from '#lib/server/notes.js';

export const GET: RequestHandler = async ({ locals, params }) =>
	Response.json(await listShares(requireCtx(locals), params.id));

export const POST: RequestHandler = async ({ locals, request, params }) => {
	await addShare(requireCtx(locals), params.id, await body(request, shareInput));
	return new Response(null, { status: 204 });
};

export const DELETE: RequestHandler = async ({ locals, request, params }) => {
	const { shareId } = await body(request, z.object({ shareId: z.uuid() }));
	await removeShare(requireCtx(locals), params.id, shareId);
	return new Response(null, { status: 204 });
};
