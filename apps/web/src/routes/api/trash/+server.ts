import type { RequestHandler } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { listTrash } from '#lib/server/calendar.js';

export const GET: RequestHandler = async ({ locals }) =>
	Response.json(await listTrash(requireCtx(locals)));
