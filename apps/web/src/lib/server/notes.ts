import { error } from '@sveltejs/kit';
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '@corpus/db';
import { atLeast, noteRole, type NoteRole } from '@corpus/db/access';
import { notify } from '@corpus/db/notify';
import { randomToken } from '@corpus/core/crypto';
import type { NoteTreeItem } from '#lib/types.js';
import type { Ctx } from './ctx.js';

const { note, noteShare, noteLink, user, team, teamMember } = schema;

export async function requireNote(ctx: Ctx, noteId: string, needed: NoteRole = 'view') {
	const role = await noteRole(ctx.userId, noteId);
	if (!atLeast(role, needed)) error(role ? 403 : 404, role ? 'Not allowed' : 'Note not found');
	const [row] = await db.select().from(note).where(eq(note.id, noteId)).limit(1);
	if (!row) error(404, 'Note not found');
	return { note: row, role: role! };
}

export async function noteTree(ctx: Ctx): Promise<NoteTreeItem[]> {
	const rows = await db
		.select({
			id: note.id,
			parentId: note.parentId,
			title: note.title,
			icon: note.icon,
			position: note.position,
			updatedAt: note.updatedAt
		})
		.from(note)
		.where(and(eq(note.workspaceId, ctx.workspaceId), isNull(note.archivedAt)))
		.orderBy(asc(note.position), asc(note.createdAt));
	return rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }));
}

/** Notes shared directly with the user (or their teams) from other workspaces. */
export async function sharedWithMe(ctx: Ctx): Promise<NoteTreeItem[]> {
	const myTeams = db
		.select({ id: teamMember.teamId })
		.from(teamMember)
		.where(eq(teamMember.userId, ctx.userId));
	const rows = await db
		.selectDistinct({
			id: note.id,
			parentId: note.parentId,
			title: note.title,
			icon: note.icon,
			position: note.position,
			updatedAt: note.updatedAt
		})
		.from(noteShare)
		.innerJoin(note, eq(noteShare.noteId, note.id))
		.where(
			and(
				isNull(note.archivedAt),
				sql`${note.workspaceId} <> ${ctx.workspaceId}`,
				or(eq(noteShare.userId, ctx.userId), inArray(noteShare.teamId, myTeams))
			)
		);
	return rows.map((r) => ({ ...r, parentId: null, updatedAt: r.updatedAt.toISOString() }));
}

export async function archivedNotes(ctx: Ctx) {
	return db
		.select({ id: note.id, title: note.title, icon: note.icon, archivedAt: note.archivedAt })
		.from(note)
		.where(and(eq(note.workspaceId, ctx.workspaceId), isNotNull(note.archivedAt)))
		.orderBy(desc(note.archivedAt));
}

export async function searchNotes(ctx: Ctx, q: string) {
	return db
		.select({
			id: note.id,
			title: note.title,
			icon: note.icon,
			snippet: sql<string>`left(${note.contentText}, 160)`
		})
		.from(note)
		.where(
			and(
				eq(note.workspaceId, ctx.workspaceId),
				isNull(note.archivedAt),
				or(ilike(note.title, `%${q}%`), ilike(note.contentText, `%${q}%`))
			)
		)
		.limit(20);
}

export const noteCreate = z.object({
	parentId: z.uuid().nullish(),
	title: z.string().max(300).default(''),
	icon: z.string().max(16).nullish()
});

export async function createNote(ctx: Ctx, input: z.infer<typeof noteCreate>) {
	let workspaceId = ctx.workspaceId;
	if (input.parentId) {
		const parent = await requireNote(ctx, input.parentId, 'edit');
		workspaceId = parent.note.workspaceId;
	}
	const [{ max } = { max: -1 }] = await db
		.select({ max: sql<number>`coalesce(max(${note.position}), -1)::int` })
		.from(note)
		.where(
			and(
				eq(note.workspaceId, workspaceId),
				input.parentId ? eq(note.parentId, input.parentId) : isNull(note.parentId)
			)
		);
	const [row] = await db
		.insert(note)
		.values({
			workspaceId,
			parentId: input.parentId ?? null,
			title: input.title,
			icon: input.icon ?? null,
			position: max + 1,
			createdBy: ctx.userId
		})
		.returning();
	return row!;
}

export const notePatch = z.object({
	title: z.string().max(300).optional(),
	icon: z.string().max(16).nullish(),
	cover: z.string().max(500).nullish(),
	parentId: z.uuid().nullish(),
	position: z.number().int().min(0).optional(),
	archived: z.boolean().optional()
});

export async function updateNote(ctx: Ctx, noteId: string, patch: z.infer<typeof notePatch>) {
	const { note: row } = await requireNote(ctx, noteId, 'edit');
	const values: Partial<typeof note.$inferInsert> = {};
	if (patch.title !== undefined) values.title = patch.title;
	if (patch.icon !== undefined) values.icon = patch.icon ?? null;
	if (patch.cover !== undefined) values.cover = patch.cover ?? null;
	if (patch.archived !== undefined) values.archivedAt = patch.archived ? new Date() : null;
	if (patch.parentId !== undefined) {
		if (patch.parentId) {
			if (patch.parentId === noteId) error(400, 'A note cannot be its own parent');
			const { note: parent } = await requireNote(ctx, patch.parentId, 'edit');
			if (parent.workspaceId !== row.workspaceId) error(400, 'Cannot move across workspaces');
			// Prevent cycles: target parent must not be inside this note.
			const [cycle] = await db.execute<{ id: string }>(sql`
				with recursive chain as (
					select id, parent_id from note where id = ${patch.parentId}
					union all select n.id, n.parent_id from note n join chain c on n.id = c.parent_id
				) select id from chain where id = ${noteId}`);
			if (cycle) error(400, 'Cannot move a note inside itself');
		}
		values.parentId = patch.parentId ?? null;
	}
	if (patch.position !== undefined) {
		const parentId = values.parentId !== undefined ? values.parentId : row.parentId;
		// Shift siblings at/after the target position down to make room.
		await db.execute(sql`
			update note set position = position + 1
			where workspace_id = ${row.workspaceId}
				and ${parentId ? sql`parent_id = ${parentId}` : sql`parent_id is null`}
				and position >= ${patch.position} and id <> ${noteId}`);
		values.position = patch.position;
	}
	const [updated] = await db.update(note).set(values).where(eq(note.id, noteId)).returning();
	return updated!;
}

export async function deleteNote(ctx: Ctx, noteId: string) {
	await requireNote(ctx, noteId, 'edit');
	await db.delete(note).where(eq(note.id, noteId));
}

export async function breadcrumbs(noteId: string) {
	return db.execute<{ id: string; title: string; icon: string | null; depth: number }>(sql`
		with recursive chain as (
			select id, parent_id, title, icon, 0 as depth from note where id = ${noteId}
			union all
			select n.id, n.parent_id, n.title, n.icon, c.depth + 1 from note n join chain c on n.id = c.parent_id
		) select id, title, icon, depth from chain order by depth desc`);
}

// ---------- sharing ----------

export async function listShares(ctx: Ctx, noteId: string) {
	const { note: row } = await requireNote(ctx, noteId, 'view');
	const [shares, links, teams] = await Promise.all([
		db
			.select({
				id: noteShare.id,
				role: noteShare.role,
				userId: noteShare.userId,
				teamId: noteShare.teamId,
				userName: user.name,
				userEmail: user.email,
				userImage: user.image,
				teamName: team.name
			})
			.from(noteShare)
			.leftJoin(user, eq(noteShare.userId, user.id))
			.leftJoin(team, eq(noteShare.teamId, team.id))
			.where(eq(noteShare.noteId, noteId)),
		db.select().from(noteLink).where(eq(noteLink.noteId, noteId)),
		db
			.select({ id: team.id, name: team.name })
			.from(team)
			.where(eq(team.organizationId, row.workspaceId))
	]);
	return { shares, links: links.map((l) => ({ token: l.token, role: l.role })), teams };
}

export const shareInput = z.object({
	email: z.email().optional(),
	teamId: z.string().optional(),
	role: z.enum(['view', 'comment', 'edit']).default('view')
});

export async function addShare(ctx: Ctx, noteId: string, input: z.infer<typeof shareInput>) {
	const { note: row } = await requireNote(ctx, noteId, 'edit');
	if (input.email) {
		const [target] = await db
			.select()
			.from(user)
			.where(eq(user.email, input.email.toLowerCase()))
			.limit(1);
		if (!target) error(404, 'No Corpus user with that email — invite them to your team first');
		const [existing] = await db
			.select()
			.from(noteShare)
			.where(and(eq(noteShare.noteId, noteId), eq(noteShare.userId, target.id)));
		if (existing)
			await db.update(noteShare).set({ role: input.role }).where(eq(noteShare.id, existing.id));
		else
			await db
				.insert(noteShare)
				.values({ noteId, userId: target.id, role: input.role, createdBy: ctx.userId });
		if (target.id !== ctx.userId) {
			await notify({
				userId: target.id,
				type: 'note_shared',
				title: `${ctx.user.name} shared “${row.title || 'Untitled'}” with you`,
				href: `/notes/${noteId}`,
				sourceType: 'note',
				sourceId: noteId,
				dedupeKey: `note_shared:${noteId}:${input.role}`
			});
		}
		return;
	}
	if (input.teamId) {
		const [t] = await db.select().from(team).where(eq(team.id, input.teamId)).limit(1);
		if (!t || t.organizationId !== row.workspaceId) error(404, 'Team not found');
		const [existing] = await db
			.select()
			.from(noteShare)
			.where(and(eq(noteShare.noteId, noteId), eq(noteShare.teamId, t.id)));
		if (existing)
			await db.update(noteShare).set({ role: input.role }).where(eq(noteShare.id, existing.id));
		else
			await db
				.insert(noteShare)
				.values({ noteId, teamId: t.id, role: input.role, createdBy: ctx.userId });
		return;
	}
	error(400, 'Provide an email or team');
}

export async function removeShare(ctx: Ctx, noteId: string, shareId: string) {
	await requireNote(ctx, noteId, 'edit');
	await db.delete(noteShare).where(and(eq(noteShare.id, shareId), eq(noteShare.noteId, noteId)));
}

export async function createLink(ctx: Ctx, noteId: string, role: 'view' | 'comment' | 'edit') {
	await requireNote(ctx, noteId, 'edit');
	await db.delete(noteLink).where(eq(noteLink.noteId, noteId));
	const [row] = await db
		.insert(noteLink)
		.values({ noteId, token: randomToken(18), role, createdBy: ctx.userId })
		.returning();
	return row!;
}

export async function revokeLink(ctx: Ctx, noteId: string) {
	await requireNote(ctx, noteId, 'edit');
	await db.delete(noteLink).where(eq(noteLink.noteId, noteId));
}
