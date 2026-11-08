import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { searchMessages } from '#lib/server/slack-connector.js';

/** search.all — supports Slack modifiers (in:#chan, from:@user, after:, before:). */
export const GET: RequestHandler = async ({ locals, url }) => {
	const q = url.searchParams.get('q')?.trim() ?? '';
	if (!q) error(400, 'Type something to search for');
	if (q.length > 500) error(400, 'Search is too long');
	const page = Math.min(100, Math.max(1, Number(url.searchParams.get('page')) || 1));
	return Response.json(await searchMessages(requireCtx(locals).userId, q, page));
};
