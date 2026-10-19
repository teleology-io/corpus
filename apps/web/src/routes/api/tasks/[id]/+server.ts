import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { deleteTask, taskPatch, updateTask } from '#lib/server/planner.js';

export const PATCH: RequestHandler = async ({ locals, request, params }) => {
	const row = await updateTask(requireCtx(locals), params.id, await body(request, taskPatch));
	return Response.json({ id: row.id, completedAt: row.completedAt });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	await deleteTask(requireCtx(locals), params.id);
	return new Response(null, { status: 204 });
};
