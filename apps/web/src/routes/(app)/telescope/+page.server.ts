import type { PageServerLoad } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { listVideos } from '#lib/server/telescope.js';

export const load: PageServerLoad = async ({ locals }) => {
	const ctx = requireCtx(locals);
	return { title: 'Telescope', videos: await listVideos(ctx) };
};
