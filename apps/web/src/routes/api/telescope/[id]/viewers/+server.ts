import type { RequestHandler } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { listViewers } from '#lib/server/telescope.js';

export const GET: RequestHandler = async ({ locals, params }) =>
	Response.json(await listViewers(requireCtx(locals), params.id));
