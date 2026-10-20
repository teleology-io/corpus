import { z } from 'zod';
import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { addGoogleCalendar, googleCalendars } from '#lib/server/integrations.js';

export const GET: RequestHandler = async ({ locals, params }) =>
	Response.json(await googleCalendars(requireCtx(locals).userId, params.id));

export const POST: RequestHandler = async ({ locals, request, params }) => {
	const ctx = requireCtx(locals);
	const { calendarId } = await body(
		request,
		z.object({ calendarId: z.string().trim().min(3).max(300) })
	);
	await addGoogleCalendar(ctx.userId, params.id, calendarId);
	return new Response(null, { status: 204 });
};
