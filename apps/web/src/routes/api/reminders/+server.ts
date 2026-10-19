import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { createReminder, listReminders, reminderInput } from '#lib/server/planner.js';

export const GET: RequestHandler = async ({ locals }) =>
	Response.json(await listReminders(requireCtx(locals)));

export const POST: RequestHandler = async ({ locals, request }) => {
	const row = await createReminder(requireCtx(locals), await body(request, reminderInput));
	return Response.json({ id: row.id }, { status: 201 });
};
