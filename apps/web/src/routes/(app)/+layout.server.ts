import type { LayoutServerLoad } from './$types';
import { optionalEnv } from '@corpus/db';
import { requireCtx } from '#lib/server/ctx.js';
import { listWorkspaces, workspaceMembers } from '#lib/server/workspaces.js';
import { unreadCount } from '#lib/server/notifications.js';

export const load: LayoutServerLoad = async ({ locals }) => {
	const ctx = requireCtx(locals);
	const [workspaces, members, unread] = await Promise.all([
		listWorkspaces(ctx.userId),
		workspaceMembers(ctx.workspaceId),
		unreadCount(ctx.userId)
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
		config: {
			vapidKey: optionalEnv('PUBLIC_VAPID_KEY') ?? null,
			collabUrl: optionalEnv('PUBLIC_COLLAB_URL') ?? 'ws://localhost:1234'
		}
	};
};
