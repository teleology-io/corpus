import type { PageServerLoad } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { listThreads, slackConnection } from '#lib/server/slack.js';

export const load: PageServerLoad = async ({ locals, url }) => {
	const ctx = requireCtx(locals);
	const conn = await slackConnection(ctx.userId);
	return {
		title: 'Slack',
		connection: conn
			? { id: conn.id, status: conn.status, account: conn.accountLogin, error: conn.lastError }
			: null,
		threads: conn ? await listThreads(ctx.userId) : [],
		selected: url.searchParams.get('thread')
	};
};
