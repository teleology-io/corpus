import { appUrl } from '#lib/server/queries.js';
import type { LayoutServerLoad } from './$types';

const host = new URL(appUrl).hostname;
const environment = ['localhost', '127.0.0.1', '[::1]'].includes(host) ? 'Local' : 'Production';

export const load: LayoutServerLoad = ({ locals }) => ({
	admin: locals.admin!,
	environment,
	appUrl,
	/** Reruns on every invalidateAll, so it doubles as "data last refreshed at". */
	loadedAt: new Date()
});
