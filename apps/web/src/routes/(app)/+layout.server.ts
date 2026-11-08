import type { LayoutServerLoad } from './$types';
import { optionalEnv } from '@corpus/db';
import { requireCtx } from '#lib/server/ctx.js';
import { listWorkspaces, workspaceMembers } from '#lib/server/workspaces.js';
import { unreadCount } from '#lib/server/notifications.js';
import { collabUrl } from '#lib/server/collab.js';
import { slackConnection, slackUnread } from '#lib/server/slack.js';

export const load: LayoutServerLoad = async ({ locals, url, depends }) => {
	depends('app:slack-connected', 'app:slack-unread');
	const ctx = requireCtx(locals);
	const [workspaces, members, unread, slack] = await Promise.all([
		listWorkspaces(ctx.userId),
		workspaceMembers(ctx.workspaceId),
		unreadCount(ctx.userId),
		slackConnection(ctx.userId)
	]);
	return {
		user: {
			id: ctx.user.id,
			name: ctx.user.name,
			email: ctx.user.email,
			image: ctx.user.image ?? null,
			timezone: ctx.tz,
			weekStartsOn: (ctx.user.weekStartsOn ?? 0) as 0 | 1 | 2 | 3 | 4 | 5 | 6,
			twoFactorEnabled: !!ctx.user.twoFactorEnabled
		},
		workspaceId: ctx.workspaceId,
		workspaces,
		members: members.map((m) => ({
			id: m.id,
			name: m.name,
			email: m.email,
			image: m.image,
			role: m.role
		})),
		unread,
		/** Slack nav entry only shows once Slack is connected */
		slackConnected: !!slack,
		slackUnread: slack ? await slackUnread(ctx.userId) : false,
		config: {
			vapidKey: optionalEnv('PUBLIC_VAPID_KEY') ?? null,
			collabUrl: collabUrl(url)
		}
	};
};
