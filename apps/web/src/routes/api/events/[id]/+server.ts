import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { deleteEvent, eventPatch, purgeEvent, updateEvent } from '#lib/server/calendar.js';

export const PATCH: RequestHandler = async ({ locals, request, params }) => {
	const ctx = requireCtx(locals);
	const row = await updateEvent(ctx, params.id, await body(request, eventPatch));
	return Response.json({ id: row.id });
};

export const DELETE: RequestHandler = async ({ locals, params, url }) => {
	const ctx = requireCtx(locals);
	if (url.searchParams.get('purge')) await purgeEvent(ctx, params.id);
	else {
		const scope = (url.searchParams.get('scope') ?? 'all') as 'this' | 'following' | 'all';
		await deleteEvent(ctx, params.id, scope, url.searchParams.get('originalStart'));
	}
	return new Response(null, { status: 204 });
};
