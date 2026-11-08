import type { PageServerLoad } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { listThreads, slackConnection } from '#lib/server/slack.js';
import { conversationById, identity, listConversations } from '#lib/server/slack-connector.js';
import type { SlackConversationDTO } from '#lib/types.js';

export const load: PageServerLoad = async ({ locals, url, depends }) => {
	depends('app:integrations', 'app:integration-status', 'app:slack');
	const ctx = requireCtx(locals);
	const conn = await slackConnection(ctx.userId);
	let conversations: SlackConversationDTO[] = [];
	let warning: string | null = null;
	if (conn && conn.status !== 'error') {
		try {
			({ conversations, warning } = await listConversations(ctx.userId));
		} catch (e) {
			// The page still works (threads, reconnect) when Slack is unreachable.
			warning =
				(e as { body?: { message?: string } }).body?.message ?? 'Couldn’t load conversations';
		}
	}
	const c = url.searchParams.get('c');
	const extra =
		c && /^[CDG][A-Z0-9]{2,30}$/.test(c) && !conversations.some((x) => x.id === c)
			? await conversationById(ctx.userId, c)
			: null;
	return {
		title: 'Slack',
		extra,
		connection: conn
			? { id: conn.id, status: conn.status, account: conn.accountLogin, error: conn.lastError }
			: null,
		identity: await identity(ctx.userId),
		threads: conn ? await listThreads(ctx.userId) : [],
		conversations,
		warning,
		selected: url.searchParams.get('thread')
	};
};
