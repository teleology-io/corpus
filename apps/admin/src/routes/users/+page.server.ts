import { error, fail } from '@sveltejs/kit';
import { logAction, requireReason, revokeSessions, setDisabled } from '#lib/server/actions.js';
import { userDetail, users, workspaceDetail, workspaces } from '#lib/server/queries.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
	const view = url.searchParams.get('view') === 'workspaces' ? 'workspaces' : 'users';
	const userId = url.searchParams.get('user');
	const workspaceId = url.searchParams.get('workspace');
	const [userRows, workspaceRows, user, workspace] = await Promise.all([
		view === 'users' ? users(q) : Promise.resolve([]),
		view === 'workspaces' ? workspaces(q) : Promise.resolve([]),
		userId ? userDetail(userId) : Promise.resolve(null),
		workspaceId ? workspaceDetail(workspaceId) : Promise.resolve(null)
	]);
	return { q, view, users: userRows, workspaces: workspaceRows, user, workspace };
};

async function target(form: FormData) {
	const id = String(form.get('user') ?? '');
	const detail = await userDetail(id);
	if (!detail) error(404, 'User not found');
	return { id, target: { type: 'user', id, label: detail.user.email } };
}

export const actions: Actions = {
	revokeSessions: async ({ request, locals }) => {
		const form = await request.formData();
		const r = requireReason(form);
		if ('error' in r) return r.error;
		const { id, target: t } = await target(form);
		const count = await revokeSessions(id);
		await logAction(locals.admin!, 'user.revoke_sessions', t, r.reason, { count });
	},
	disable: async ({ request, locals }) => {
		const form = await request.formData();
		const r = requireReason(form);
		if ('error' in r) return r.error;
		const { id, target: t } = await target(form);
		if (id === locals.admin!.id) return fail(400, { error: 'You can’t disable your own account.' });
		await setDisabled(id, true);
		await logAction(locals.admin!, 'user.disable', t, r.reason);
	},
	enable: async ({ request, locals }) => {
		const { id, target: t } = await target(await request.formData());
		await setDisabled(id, false);
		await logAction(locals.admin!, 'user.enable', t);
	}
};
