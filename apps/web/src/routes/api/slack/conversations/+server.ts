import type { RequestHandler } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { listConversations } from '#lib/server/slack-connector.js';

/** Cached sidebar list; `?refresh=1` re-syncs from Slack first. */
export const GET: RequestHandler = async ({ locals, url }) =>
	Response.json(
		await listConversations(requireCtx(locals).userId, url.searchParams.get('refresh') === '1')
	);
