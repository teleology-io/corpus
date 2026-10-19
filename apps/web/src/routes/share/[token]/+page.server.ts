import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { db, env, optionalEnv, schema } from '@corpus/db';
import { linkRole } from '@corpus/db/access';
import { randomToken, signToken } from '@corpus/core/crypto';

/** Public note view via share link — collab token is minted server-side with the link's role. */
export const load: PageServerLoad = async ({ params, locals }) => {
	const link = await linkRole(params.token);
	if (!link) error(404, 'This link is invalid or has been turned off');
	const [note] = await db
		.select()
		.from(schema.note)
		.where(eq(schema.note.id, link.noteId))
		.limit(1);
	if (!note || note.archivedAt) error(404, 'Page not found');
	const name = locals.user?.name ?? 'Guest';
	const sub = locals.user?.id ?? `guest:${randomToken(8)}`;
	return {
		note: { id: note.id, title: note.title, icon: note.icon },
		role: link.role,
		viewer: { id: sub, name },
		token: signToken(
			{ sub, name, note: note.id, role: link.role, link: params.token },
			env('BETTER_AUTH_SECRET', 'dev-secret-change-me-dev-secret-change-me'),
			60 * 60 * 12
		),
		collabUrl: optionalEnv('PUBLIC_COLLAB_URL') ?? 'ws://localhost:1234'
	};
};
