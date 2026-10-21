import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { db, sql } from './index';
import { noteLink, telescopeVideo } from './schema/index';

export type NoteRole = 'owner' | 'edit' | 'comment' | 'view';

const RANK: Record<NoteRole, number> = { view: 1, comment: 2, edit: 3, owner: 4 };

export function atLeast(role: NoteRole | null, needed: NoteRole) {
	return !!role && RANK[role] >= RANK[needed];
}

/**
 * Effective role for a user on a note: workspace members get `edit` (creator: `owner`);
 * otherwise the strongest share on the note or any ancestor (user or team share).
 */
export async function noteRole(userId: string, noteId: string): Promise<NoteRole | null> {
	const rows = await sql<{ role: string | null; is_member: boolean; is_creator: boolean }[]>`
		with recursive chain as (
			select id, parent_id, workspace_id, created_by from note where id = ${noteId}
			union all
			select n.id, n.parent_id, n.workspace_id, n.created_by from note n join chain c on n.id = c.parent_id
		)
		select
			(select created_by = ${userId} from note where id = ${noteId}) as is_creator,
			exists(
				select 1 from member m join note n on n.workspace_id = m.organization_id
				where n.id = ${noteId} and m.user_id = ${userId}
			) as is_member,
			(
				select s.role from note_share s
				where s.note_id in (select id from chain)
					and (
						s.user_id = ${userId}
						or s.team_id in (select team_id from team_member where user_id = ${userId})
					)
				order by case s.role when 'edit' then 3 when 'comment' then 2 else 1 end desc
				limit 1
			) as role
	`;
	const r = rows[0];
	if (!r) return null;
	if (r.is_member) return r.is_creator ? 'owner' : 'edit';
	return (r.role as NoteRole | null) ?? null;
}

/** Role granted by a public link token for a note (link on the note or an ancestor). */
export async function linkRole(token: string): Promise<{ noteId: string; role: NoteRole } | null> {
	const [row] = await db
		.select()
		.from(noteLink)
		.where(
			and(
				eq(noteLink.token, token),
				or(isNull(noteLink.expiresAt), gt(noteLink.expiresAt, new Date()))
			)
		)
		.limit(1);
	return row ? { noteId: row.noteId, role: row.role as NoteRole } : null;
}

/** Whether `noteId` is `rootId` or a descendant of it. */
export async function isWithin(noteId: string, rootId: string) {
	if (noteId === rootId) return true;
	const rows = await sql<{ id: string }[]>`
		with recursive chain as (
			select id, parent_id from note where id = ${noteId}
			union all
			select n.id, n.parent_id from note n join chain c on n.id = c.parent_id
		)
		select id from chain where id = ${rootId}
	`;
	return rows.length > 0;
}

/** Telescope videos are owner-only in the app; everyone else watches through a link. */
export async function videoRole(userId: string, videoId: string): Promise<'owner' | null> {
	const [row] = await db
		.select({ ownerId: telescopeVideo.ownerId })
		.from(telescopeVideo)
		.where(eq(telescopeVideo.id, videoId))
		.limit(1);
	return row?.ownerId === userId ? 'owner' : null;
}

/** The video a share token opens — only while its link is switched on and the upload finished. */
export async function videoLinkRole(token: string) {
	const [row] = await db
		.select()
		.from(telescopeVideo)
		.where(
			and(
				eq(telescopeVideo.linkToken, token),
				eq(telescopeVideo.visibility, 'link'),
				eq(telescopeVideo.status, 'ready')
			)
		)
		.limit(1);
	return row ? { video: row, role: 'view' as const } : null;
}
