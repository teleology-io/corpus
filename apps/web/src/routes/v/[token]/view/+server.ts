import { error } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { videoLinkRole } from '@corpus/db/access';
import { body } from '#lib/server/ctx.js';
import { ANON_COOKIE, recordView } from '#lib/server/telescope.js';

/**
 * Sent by the player after ~2s of actual playback, then as a heartbeat. Signed-in viewers are
 * keyed by user id, everyone else by the anonymous cookie set on the watch page.
 */
export const POST: RequestHandler = async ({ request, params, locals, cookies }) => {
	const link = await videoLinkRole(params.token);
	if (!link) error(404, 'Not found');
	const { watchedMs } = await body(request, z.object({ watchedMs: z.number().min(0) }));
	const anonId = cookies.get(ANON_COOKIE);
	if (locals.user) await recordView(link.video, { userId: locals.user.id }, watchedMs);
	else if (anonId && /^[A-Za-z0-9_-]{8,64}$/.test(anonId))
		await recordView(link.video, { anonId }, watchedMs);
	return new Response(null, { status: 204 });
};
