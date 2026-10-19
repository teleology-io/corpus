import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { createTask, listTasks, taskInput } from '#lib/server/planner.js';

export const GET: RequestHandler = async ({ locals, url }) => {
	const ctx = requireCtx(locals);
	const from = url.searchParams.get('from');
	const to = url.searchParams.get('to');
	return Response.json(
		await listTasks(ctx, {
			from: from ? new Date(from) : undefined,
			to: to ? new Date(to) : undefined,
			includeUndated: url.searchParams.has('undated'),
			includeOverdue: url.searchParams.has('overdue')
		})
	);
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const row = await createTask(requireCtx(locals), await body(request, taskInput));
	return Response.json({ id: row.id }, { status: 201 });
};
