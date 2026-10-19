import type { LayoutServerLoad } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { archivedNotes, noteTree, sharedWithMe } from '#lib/server/notes.js';

export const load: LayoutServerLoad = async ({ locals, depends }) => {
	depends('app:notes-tree');
	const ctx = requireCtx(locals);
	const [tree, shared, archived] = await Promise.all([
		noteTree(ctx),
		sharedWithMe(ctx),
		archivedNotes(ctx)
	]);
	return { tree, shared, archived, title: 'My Notes' };
};
