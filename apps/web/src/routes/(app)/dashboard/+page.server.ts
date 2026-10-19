import type { PageServerLoad } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { dashboard } from '#lib/server/dashboard.js';

export const load: PageServerLoad = async ({ locals, depends }) => {
	depends('app:dashboard');
	const ctx = requireCtx(locals);
	return { title: 'Dashboard', ...(await dashboard(ctx)) };
};
