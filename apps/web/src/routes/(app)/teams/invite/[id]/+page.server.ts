import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { invitationById } from '#lib/server/teams.js';

export const load: PageServerLoad = async ({ locals, params }) => {
	const ctx = requireCtx(locals);
	const invite = await invitationById(params.id);
	if (!invite) error(404, 'Invitation not found');
	return {
		title: 'Invitation',
		invite: { ...invite, expiresAt: invite.expiresAt.toISOString() },
		emailMatches: invite.email.toLowerCase() === ctx.user.email.toLowerCase()
	};
};
