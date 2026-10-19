import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { deleteReminder, reminderInput, updateReminder } from '#lib/server/planner.js';

export const PATCH: RequestHandler = async ({ locals, request, params }) => {
	const row = await updateReminder(
		requireCtx(locals),
		params.id,
		await body(request, reminderInput.partial())
	);
	return Response.json({ id: row.id });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	await deleteReminder(requireCtx(locals), params.id);
	return new Response(null, { status: 204 });
};
