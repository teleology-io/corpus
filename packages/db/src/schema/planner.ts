import { relations } from 'drizzle-orm';
import {
	boolean,
	index,
	integer,
	pgTable,
	text,
	time,
	uuid,
	date,
	uniqueIndex
} from 'drizzle-orm/pg-core';
import { createdAt, id, tstz, updatedAt, userRef, workspaceRef } from './_helpers';

export const task = pgTable(
	'task',
	{
		id: id(),
		workspaceId: workspaceRef(),
		title: text('title').notNull(),
		notes: text('notes'),
		dueAt: tstz('due_at'),
		/** Due on a date with no specific time */
		dueAllDay: boolean('due_all_day').notNull().default(true),
		/** 0 none, 1 low, 2 medium, 3 high */
		priority: integer('priority').notNull().default(0),
		completedAt: tstz('completed_at'),
		assigneeId: userRef('assignee_id'),
		/** manual | github | linear */
		source: text('source').notNull().default('manual'),
		externalUrl: text('external_url'),
		integrationItemId: uuid('integration_item_id'),
		createdBy: userRef('created_by'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		index('task_workspace_due_idx').on(t.workspaceId, t.dueAt),
		index('task_completed_idx').on(t.workspaceId, t.completedAt)
	]
);

export const reminder = pgTable(
	'reminder',
	{
		id: id(),
		workspaceId: workspaceRef(),
		userId: userRef('user_id').notNull(),
		title: text('title').notNull(),
		notes: text('notes'),
		/** First fire time; with rrule it's DTSTART */
		startsAt: tstz('starts_at').notNull(),
		timezone: text('timezone').notNull().default('UTC'),
		rrule: text('rrule'),
		active: boolean('active').notNull().default(true),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [index('reminder_user_idx').on(t.userId, t.active)]
);

/** Prescription / on-off cycles, e.g. 6 weeks on, 3 weeks off. */
export const cycle = pgTable(
	'cycle',
	{
		id: id(),
		workspaceId: workspaceRef(),
		userId: userRef('user_id').notNull(),
		name: text('name').notNull(),
		/** medication | supplement | training | other */
		kind: text('kind').notNull().default('medication'),
		doseLabel: text('dose_label'),
		startDate: date('start_date', { mode: 'string' }).notNull(),
		onDays: integer('on_days').notNull(),
		offDays: integer('off_days').notNull(),
		/** null = repeat forever */
		repeatCount: integer('repeat_count'),
		/** Local wall-clock times in the cycle timezone, e.g. 08:00, 20:00 */
		doseTimes: time('dose_times').array().notNull().default([]),
		timezone: text('timezone').notNull().default('UTC'),
		color: text('color').notNull().default('#8E4EC6'),
		notes: text('notes'),
		pausedAt: tstz('paused_at'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [index('cycle_user_idx').on(t.userId)]
);

export const doseLog = pgTable(
	'dose_log',
	{
		id: id(),
		cycleId: uuid('cycle_id')
			.notNull()
			.references(() => cycle.id, { onDelete: 'cascade' }),
		scheduledFor: tstz('scheduled_for').notNull(),
		/** taken | skipped | missed */
		status: text('status').notNull(),
		loggedAt: tstz('logged_at').defaultNow().notNull()
	},
	(t) => [uniqueIndex('dose_log_unique').on(t.cycleId, t.scheduledFor)]
);

export const cycleRelations = relations(cycle, ({ many }) => ({ doses: many(doseLog) }));
export const doseLogRelations = relations(doseLog, ({ one }) => ({
	cycle: one(cycle, { fields: [doseLog.cycleId], references: [cycle.id] })
}));
