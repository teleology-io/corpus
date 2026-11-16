import type { PageServerLoad } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { getPrefs } from '#lib/server/notifications.js';
import { listCategories } from '#lib/server/calendar.js';
import { getSettings } from '#lib/server/settings.js';
import { workbenchAllowed } from '#lib/server/wrx/access.js';

export const load: PageServerLoad = async ({ locals }) => {
	const ctx = requireCtx(locals);
	const [prefs, categories, settings] = await Promise.all([
		getPrefs(ctx.userId),
		listCategories(ctx.workspaceId),
		getSettings(ctx.userId, ['standup.enabled', 'standup.detail'])
	]);
	return {
		title: 'Settings',
		prefs,
		categories,
		settings,
		hostedStandup: workbenchAllowed(ctx.user.email),
		timezones: Intl.supportedValuesOf('timeZone')
	};
};
