import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { randomToken } from '@corpus/core/crypto';
import { requireCtx } from '#lib/server/ctx.js';
import { requireProvider } from '#lib/server/integrations.js';

export const GET: RequestHandler = async ({ locals, params, cookies, url }) => {
	requireCtx(locals);
	const { provider, cfg } = await requireProvider(params.provider);
	const state = randomToken(16);
	cookies.set(`oauth_${provider.id}`, state, {
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		maxAge: 600
	});
	redirect(302, provider.authorizeUrl(cfg, state), { external: true });
};
