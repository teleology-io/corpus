import { relations } from 'drizzle-orm';
import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import { integrationConnection } from './integrations';
import { createdAt, id, tstz, updatedAt, userRef, workspaceRef } from './_helpers';

export const calendar = pgTable(
	'calendar',
	{
		id: id(),
		workspaceId: workspaceRef(),
		name: text('name').notNull(),
		color: text('color').notNull().default('#2C87F2'),
		isDefault: boolean('is_default').notNull().default(false),
		/** Secret token for the subscribable .ics feed */
		feedToken: text('feed_token'),
		/** Set when this calendar mirrors an external one (Google Calendar) */
		connectionId: uuid('connection_id').references(() => integrationConnection.id, {
			onDelete: 'cascade'
		}),
		externalId: text('external_id'),
		/** Provider incremental-sync cursor (Google nextSyncToken) */
		syncToken: text('sync_token'),
		/** External calendar the user can only read */
		readOnly: boolean('read_only').notNull().default(false),
		createdBy: userRef('created_by'),
		createdAt: createdAt()
	},
	(t) => [
		index('calendar_workspace_idx').on(t.workspaceId),
		uniqueIndex('calendar_external_unique').on(t.connectionId, t.externalId)
	]
);

/** "Mark Schedule" categories (Audience, Meeting, Presentation, ...) */
export const category = pgTable(
	'category',
	{
		id: id(),
		workspaceId: workspaceRef(),
		name: text('name').notNull(),
		icon: text('icon').notNull().default('calendar'),
		color: text('color').notNull(),
		position: integer('position').notNull().default(0)
	},
	(t) => [index('category_workspace_idx').on(t.workspaceId)]
);

export const DEFAULT_CATEGORIES = [
	{ name: 'Meeting', icon: 'users', color: '#E5484D', position: 0 },
	{ name: 'Audience', icon: 'presentation', color: '#2C87F2', position: 1 },
	{ name: 'Presentation', icon: 'graduation-cap', color: '#30A46C', position: 2 },
	{ name: 'Session', icon: 'camera', color: '#F5A524', position: 3 },
	{ name: 'Review', icon: 'message-square', color: '#8E4EC6', position: 4 },
	{ name: 'Appointment', icon: 'stethoscope', color: '#0EA5A4', position: 5 },
	{ name: 'Personal', icon: 'heart', color: '#E93D82', position: 6 }
] as const;

export const event = pgTable(
	'event',
	{
		id: id(),
		workspaceId: workspaceRef(),
		calendarId: uuid('calendar_id')
			.notNull()
			.references(() => calendar.id, { onDelete: 'cascade' }),
		categoryId: uuid('category_id').references(() => category.id, { onDelete: 'set null' }),
		title: text('title').notNull(),
		description: text('description'),
		location: text('location'),
		color: text('color').notNull().default('#2C87F2'),
		/** 0-100 */
		opacity: integer('opacity').notNull().default(100),
		startsAt: tstz('starts_at').notNull(),
		endsAt: tstz('ends_at').notNull(),
		/** IANA tz the event was authored in — recurrence expands in this zone */
		timezone: text('timezone').notNull().default('UTC'),
		allDay: boolean('all_day').notNull().default(false),
		/** RFC 5545 RRULE body, e.g. FREQ=WEEKLY;BYDAY=MO,WE */
		rrule: text('rrule'),
		exdates: tstz('exdates').array().notNull().default([]),
		/** Minutes-before offsets for notifications, e.g. [10, 60] */
		reminders: integer('reminders').array().notNull().default([10]),
		noteId: uuid('note_id'),
		/** Id/etag of the mirrored event in an external calendar */
		externalId: text('external_id'),
		externalEtag: text('external_etag'),
		externalMeta: jsonb('external_meta').$type<{
			url?: string | null;
			meetUrl?: string | null;
			organizer?: string | null;
			organizerSelf?: boolean;
		}>(),
		/** Local change not yet pushed to the external calendar */
		syncDirty: boolean('sync_dirty').notNull().default(false),
		deletedAt: tstz('deleted_at'),
		createdBy: userRef('created_by'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		index('event_workspace_range_idx').on(t.workspaceId, t.startsAt),
		index('event_calendar_idx').on(t.calendarId),
		uniqueIndex('event_external_unique').on(t.calendarId, t.externalId)
	]
);

/** Edits to a single occurrence of a recurring event. */
export const eventOverride = pgTable(
	'event_override',
	{
		id: id(),
		eventId: uuid('event_id')
			.notNull()
			.references(() => event.id, { onDelete: 'cascade' }),
		originalStart: tstz('original_start').notNull(),
		patch: jsonb('patch')
			.$type<{
				title?: string;
				description?: string | null;
				location?: string | null;
				color?: string;
				startsAt?: string;
				endsAt?: string;
				cancelled?: boolean;
			}>()
			.notNull(),
		createdAt: createdAt()
	},
	(t) => [index('event_override_event_idx').on(t.eventId, t.originalStart)]
);

export const eventAttendee = pgTable(
	'event_attendee',
	{
		id: id(),
		eventId: uuid('event_id')
			.notNull()
			.references(() => event.id, { onDelete: 'cascade' }),
		userId: userRef('user_id'),
		email: text('email'),
		name: text('name'),
		/** pending | accepted | declined | tentative */
		rsvp: text('rsvp').notNull().default('pending'),
		createdAt: createdAt()
	},
	(t) => [
		index('event_attendee_event_idx').on(t.eventId),
		index('event_attendee_user_idx').on(t.userId)
	]
);

export const eventRelations = relations(event, ({ one, many }) => ({
	calendar: one(calendar, { fields: [event.calendarId], references: [calendar.id] }),
	category: one(category, { fields: [event.categoryId], references: [category.id] }),
	attendees: many(eventAttendee),
	overrides: many(eventOverride)
}));

export const eventAttendeeRelations = relations(eventAttendee, ({ one }) => ({
	event: one(event, { fields: [eventAttendee.eventId], references: [event.id] }),
	user: one(user, { fields: [eventAttendee.userId], references: [user.id] })
}));

export const eventOverrideRelations = relations(eventOverride, ({ one }) => ({
	event: one(event, { fields: [eventOverride.eventId], references: [event.id] })
}));
