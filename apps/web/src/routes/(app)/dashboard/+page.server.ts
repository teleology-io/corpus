import type { PageServerLoad } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { dashboard } from '#lib/server/dashboard.js';
import { getSettings } from '#lib/server/settings.js';

export const load: PageServerLoad = async ({ locals, depends }) => {
	depends('app:dashboard', 'app:integrations');
	const ctx = requireCtx(locals);
	const [board, standup] = await Promise.all([
		dashboard(ctx),
		getSettings(ctx.userId, ['standup.enabled', 'standup.detail'])
	]);
	return { title: 'Dashboard', ...board, standup };
};
