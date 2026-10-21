import type { PageServerLoad } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { listViewers, videoDetail } from '#lib/server/telescope.js';

export const load: PageServerLoad = async ({ locals, params }) => {
	const ctx = requireCtx(locals);
	const detail = await videoDetail(ctx, params.id);
	return {
		title: 'Telescope',
		...detail,
		viewers: await listViewers(ctx, params.id)
	};
};
