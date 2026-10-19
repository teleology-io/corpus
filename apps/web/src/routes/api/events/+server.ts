import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { createEvent, eventInput, listOccurrences } from '#lib/server/calendar.js';

export const GET: RequestHandler = async ({ locals, url }) => {
	const ctx = requireCtx(locals);
	const from = new Date(url.searchParams.get('from') ?? Date.now());
	const to = new Date(url.searchParams.get('to') ?? Date.now() + 7 * 86_400_000);
	const q = url.searchParams.get('q') ?? undefined;
	return Response.json(await listOccurrences(ctx, from, to, { search: q }));
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const ctx = requireCtx(locals);
	const row = await createEvent(ctx, await body(request, eventInput));
	return Response.json({ id: row.id }, { status: 201 });
};
