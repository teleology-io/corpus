import type { PageServerLoad } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { workbenchAllowed } from '#lib/server/wrx/access.js';

export const load: PageServerLoad = async ({ locals }) => {
	const ctx = requireCtx(locals);
	return { title: 'Workbench', enabled: workbenchAllowed(ctx.user.email) };
};
