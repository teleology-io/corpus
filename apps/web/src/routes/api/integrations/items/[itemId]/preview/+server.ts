import type { RequestHandler } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { itemPreview } from '#lib/server/integrations.js';

export const GET: RequestHandler = async ({ locals, params }) =>
	Response.json(await itemPreview(requireCtx(locals).userId, params.itemId));
