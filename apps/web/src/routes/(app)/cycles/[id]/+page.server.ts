import type { PageServerLoad } from './$types';
import { describeCycle, localDate, phaseOn } from '@corpus/core';
import { requireCtx } from '#lib/server/ctx.js';
import { adherence, doses, getCycle } from '#lib/server/planner.js';

export const load: PageServerLoad = async ({ locals, params }) => {
	const ctx = requireCtx(locals);
	const c = await getCycle(ctx, params.id);
	const def = { ...c, doseTimes: c.doseTimes.map((t) => t.slice(0, 5)) };
	const now = new Date();
	const [stats, recent, upcoming] = await Promise.all([
		adherence(ctx, c.id, 30),
		doses(ctx, new Date(now.getTime() - 14 * 86_400_000), now),
		doses(ctx, now, new Date(now.getTime() + 7 * 86_400_000))
	]);
	return {
		title: c.name,
		cycle: def,
		summary: describeCycle(c),
		phase: phaseOn(def, localDate(now, ctx.tz)),
		stats: { scheduled: stats.scheduled, taken: stats.taken, rate: stats.rate },
		recent: recent.filter((d) => d.cycleId === c.id).reverse(),
		upcoming: upcoming.filter((d) => d.cycleId === c.id)
	};
};
