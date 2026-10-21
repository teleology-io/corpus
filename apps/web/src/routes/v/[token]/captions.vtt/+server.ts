import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { videoLinkRole } from '@corpus/db/access';
import { toVtt } from '@corpus/core/telescope';

export const GET: RequestHandler = async ({ params }) => {
	const link = await videoLinkRole(params.token);
	if (!link) error(404, 'Not found');
	return new Response(toVtt(link.video.transcript ?? []), {
		headers: { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' }
	});
};
