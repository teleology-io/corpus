import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { videoLinkRole } from '@corpus/db/access';
import { serveObject } from '#lib/server/telescope.js';

export const GET: RequestHandler = async ({ request, params }) => {
	const link = await videoLinkRole(params.token);
	if (!link) error(404, 'Not found');
	return serveObject(request, link.video.fileKey, link.video.mime);
};
