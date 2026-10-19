import type { RequestHandler } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { googleCalendars } from '#lib/server/integrations.js';

export const GET: RequestHandler = async ({ locals, params }) =>
	Response.json(await googleCalendars(requireCtx(locals).userId, params.id));
