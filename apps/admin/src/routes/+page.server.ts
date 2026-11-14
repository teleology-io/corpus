import { audit, jobs, metrics, providers, services } from '#lib/server/queries.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const [m, svc, js, prov, activity] = await Promise.all([
		metrics(),
		services(),
		jobs(),
		providers(),
		audit('', 5)
	]);
	return { metrics: m, services: svc, jobs: js, providers: prov, activity };
};
