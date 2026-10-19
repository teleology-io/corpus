import type { PageServerLoad } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { teamsPage } from '#lib/server/teams.js';

export const load: PageServerLoad = async ({ locals, url }) => {
	const ctx = requireCtx(locals);
	return { title: 'Teams', ...(await teamsPage(ctx)), openCreate: url.searchParams.has('create') };
};
