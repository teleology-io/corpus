import type { RequestHandler } from './$types';
import { env } from '@corpus/db';
import { signToken } from '@corpus/core/crypto';
import { requireCtx } from '#lib/server/ctx.js';
import { requireNote } from '#lib/server/notes.js';

/** Short-lived token the collab websocket server verifies (role baked in). */
export const GET: RequestHandler = async ({ locals, params }) => {
	const ctx = requireCtx(locals);
	const { role } = await requireNote(ctx, params.id, 'view');
	const token = signToken(
		{ sub: ctx.userId, name: ctx.user.name, note: params.id, role },
		env('BETTER_AUTH_SECRET', 'dev-secret-change-me-dev-secret-change-me'),
		60 * 60
	);
	return Response.json({ token, role });
};
