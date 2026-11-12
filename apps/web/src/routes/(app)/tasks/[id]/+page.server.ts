import type { PageServerLoad } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { getTask } from '#lib/server/planner.js';

export const load: PageServerLoad = async ({ locals, params, depends }) => {
	depends('app:dashboard');
	const ctx = requireCtx(locals);
	const task = await getTask(ctx, params.id);
	return { title: task.title, task, tz: ctx.tz };
};
