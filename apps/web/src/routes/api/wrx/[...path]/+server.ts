import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { requireCtx } from '#lib/server/ctx.js';
import { workbenchAllowed } from '#lib/server/wrx/access.js';
import { handleWrx } from '#lib/server/wrx/index.js';

/** Workbench (ported WRX) API: state, workspaces, agent threads, files, runtimes and live events. */
const handle: RequestHandler = ({ locals, request, url, params }) => {
	const ctx = requireCtx(locals);
	if (!workbenchAllowed(ctx.user.email))
		return json({ error: 'Workbench is not enabled for this account' }, { status: 403 });
	return handleWrx({ request, url, route: params.path, userId: ctx.userId });
};

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
