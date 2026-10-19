import type { PageServerLoad } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { getPrefs } from '#lib/server/notifications.js';
import { listCategories } from '#lib/server/calendar.js';

export const load: PageServerLoad = async ({ locals }) => {
	const ctx = requireCtx(locals);
	const [prefs, categories] = await Promise.all([
		getPrefs(ctx.userId),
		listCategories(ctx.workspaceId)
	]);
	return { title: 'Settings', prefs, categories, timezones: Intl.supportedValuesOf('timeZone') };
};
