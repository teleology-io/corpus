import { relations } from 'drizzle-orm';
import { type AnyPgColumn, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { team } from './auth';
import { bytea, createdAt, id, tstz, updatedAt, userRef, workspaceRef } from './_helpers';

export const note = pgTable(
	'note',
	{
		id: id(),
		workspaceId: workspaceRef(),
		parentId: uuid('parent_id').references((): AnyPgColumn => note.id, { onDelete: 'cascade' }),
		position: integer('position').notNull().default(0),
		title: text('title').notNull().default(''),
		icon: text('icon'),
		cover: text('cover'),
		/** Yjs document state (source of truth for content) */
		ydoc: bytea('ydoc'),
		/** Plain-text projection for search/preview */
		contentText: text('content_text').notNull().default(''),
		archivedAt: tstz('archived_at'),
		createdBy: userRef('created_by'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [index('note_workspace_parent_idx').on(t.workspaceId, t.parentId)]
);

/** Share with a user or a team. role: view | comment | edit */
export const noteShare = pgTable(
	'note_share',
	{
		id: id(),
		noteId: uuid('note_id')
			.notNull()
			.references(() => note.id, { onDelete: 'cascade' }),
		userId: userRef('user_id'),
		teamId: text('team_id').references(() => team.id, { onDelete: 'cascade' }),
		role: text('role').notNull().default('view'),
		createdBy: userRef('created_by'),
		createdAt: createdAt()
	},
	(t) => [index('note_share_note_idx').on(t.noteId), index('note_share_user_idx').on(t.userId)]
);

/** Public link sharing */
export const noteLink = pgTable(
	'note_link',
	{
		id: id(),
		noteId: uuid('note_id')
			.notNull()
			.references(() => note.id, { onDelete: 'cascade' }),
		token: text('token').notNull().unique(),
		role: text('role').notNull().default('view'),
		expiresAt: tstz('expires_at'),
		createdBy: userRef('created_by'),
		createdAt: createdAt()
	},
	(t) => [index('note_link_note_idx').on(t.noteId)]
);

export const noteRelations = relations(note, ({ one, many }) => ({
	parent: one(note, { fields: [note.parentId], references: [note.id], relationName: 'tree' }),
	children: many(note, { relationName: 'tree' }),
	shares: many(noteShare),
	links: many(noteLink)
}));
export const noteShareRelations = relations(noteShare, ({ one }) => ({
	note: one(note, { fields: [noteShare.noteId], references: [note.id] })
}));
export const noteLinkRelations = relations(noteLink, ({ one }) => ({
	note: one(note, { fields: [noteLink.noteId], references: [note.id] })
}));
