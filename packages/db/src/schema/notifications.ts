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
import { createdAt, id, tstz, userRef } from './_helpers';

export const notification = pgTable(
	'notification',
	{
		id: id(),
		userId: userRef('user_id').notNull(),
		workspaceId: text('workspace_id'),
		type: text('type').notNull(),
		title: text('title').notNull(),
		body: text('body'),
		href: text('href'),
		sourceType: text('source_type'),
		sourceId: text('source_id'),
		/** Idempotency key so the scheduler never double-notifies */
		dedupeKey: text('dedupe_key').notNull(),
		data: jsonb('data').$type<Record<string, unknown>>(),
		readAt: tstz('read_at'),
		createdAt: createdAt()
	},
	(t) => [
		uniqueIndex('notification_dedupe_idx').on(t.userId, t.dedupeKey),
		index('notification_user_idx').on(t.userId, t.createdAt)
	]
);

export const notificationDelivery = pgTable(
	'notification_delivery',
	{
		id: id(),
		notificationId: uuid('notification_id')
			.notNull()
			.references(() => notification.id, { onDelete: 'cascade' }),
		/** push | email */
		channel: text('channel').notNull(),
		/** pending | sent | failed | skipped */
		status: text('status').notNull().default('pending'),
		error: text('error'),
		attempts: integer('attempts').notNull().default(0),
		sentAt: tstz('sent_at'),
		createdAt: createdAt()
	},
	(t) => [uniqueIndex('notification_delivery_unique').on(t.notificationId, t.channel)]
);

export const notificationPref = pgTable(
	'notification_pref',
	{
		id: id(),
		userId: userRef('user_id').notNull(),
		type: text('type').notNull(),
		inApp: boolean('in_app').notNull().default(true),
		push: boolean('push').notNull().default(true),
		email: boolean('email').notNull().default(false)
	},
	(t) => [uniqueIndex('notification_pref_unique').on(t.userId, t.type)]
);

export const notificationSettings = pgTable('notification_settings', {
	userId: userRef('user_id').primaryKey(),
	/** "22:00" — local time in user tz; null disables quiet hours */
	quietStart: text('quiet_start'),
	quietEnd: text('quiet_end'),
	dailyDigest: boolean('daily_digest').notNull().default(false)
});

export const pushSubscription = pgTable(
	'push_subscription',
	{
		id: id(),
		userId: userRef('user_id').notNull(),
		endpoint: text('endpoint').notNull().unique(),
		keys: jsonb('keys').$type<{ p256dh: string; auth: string }>().notNull(),
		userAgent: text('user_agent'),
		createdAt: createdAt()
	},
	(t) => [index('push_subscription_user_idx').on(t.userId)]
);
