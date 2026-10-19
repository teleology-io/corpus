import type { PageServerLoad } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { breadcrumbs, requireNote } from '#lib/server/notes.js';

export const load: PageServerLoad = async ({ locals, params }) => {
	const ctx = requireCtx(locals);
	const { note, role } = await requireNote(ctx, params.id, 'view');
	const crumbs = await breadcrumbs(note.id);
	return {
		title: 'My Notes',
		note: {
			id: note.id,
			title: note.title,
			icon: note.icon,
			workspaceId: note.workspaceId,
			archivedAt: note.archivedAt?.toISOString() ?? null,
			updatedAt: note.updatedAt.toISOString()
		},
		role,
		crumbs: [...crumbs].map((c) => ({ id: c.id, title: c.title, icon: c.icon }))
	};
};
