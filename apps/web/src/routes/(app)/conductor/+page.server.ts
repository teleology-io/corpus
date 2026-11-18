import type { PageServerLoad } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { board, localDay, requireConductor } from '#lib/server/conductor.js';

export const load: PageServerLoad = async ({ locals, depends }) => {
	depends('app:conductor');
	const ctx = requireCtx(locals);
	requireConductor(ctx.user.email);
	return { title: 'Conductor', today: localDay(ctx.tz), ...(await board(ctx.userId)) };
};
