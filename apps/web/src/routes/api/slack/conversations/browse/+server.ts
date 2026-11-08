import type { RequestHandler } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { browseConversations } from '#lib/server/slack-connector.js';

/** Channels visible to the user in Slack (conversations.list), joined or not. */
export const GET: RequestHandler = async ({ locals, url }) =>
	Response.json(
		await browseConversations(
			requireCtx(locals).userId,
			url.searchParams.get('cursor')?.slice(0, 500) || undefined
		)
	);
