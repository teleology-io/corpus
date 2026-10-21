import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { videoLinkRole } from '@corpus/db/access';
import { randomToken } from '@corpus/core/crypto';
import { ANON_COOKIE } from '#lib/server/telescope.js';

/** Public watch page for "anyone with the link" videos. Signed-in viewers count as authed. */
export const load: PageServerLoad = async ({ params, locals, cookies }) => {
	const link = await videoLinkRole(params.token);
	if (!link) error(404, 'This video is private or the link has been turned off');
	const v = link.video;
	if (!locals.user && !cookies.get(ANON_COOKIE)) {
		cookies.set(ANON_COOKIE, randomToken(16), {
			path: '/v',
			httpOnly: true,
			sameSite: 'lax',
			maxAge: 60 * 60 * 24 * 365
		});
	}
	return {
		token: params.token,
		video: {
			title: v.title,
			durationMs: v.durationMs,
			width: v.width,
			height: v.height,
			hasThumb: !!v.thumbKey,
			createdAt: v.createdAt.toISOString()
		},
		transcript: v.transcript ?? [],
		isOwner: locals.user?.id === v.ownerId,
		signedIn: !!locals.user
	};
};
