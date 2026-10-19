import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { requireProvider, saveConnection } from '#lib/server/integrations.js';

export const GET: RequestHandler = async ({ locals, params, cookies, url }) => {
	const ctx = requireCtx(locals);
	const { provider, cfg } = await requireProvider(params.provider);
	const expected = cookies.get(`oauth_${provider.id}`);
	cookies.delete(`oauth_${provider.id}`, {});
	const state = url.searchParams.get('state');
	const code = url.searchParams.get('code');
	if (!expected || state !== expected) error(400, 'OAuth state mismatch — try connecting again');
	if (!code)
		redirect(
			303,
			`/integrations?error=${encodeURIComponent(url.searchParams.get('error') ?? 'denied')}`
		);

	const tokens = await provider.exchangeCode(cfg, code);
	const account = await provider.account(tokens.accessToken);
	await saveConnection(ctx.userId, provider.id, tokens, account);
	redirect(303, `/integrations?connected=${provider.id}`);
};
