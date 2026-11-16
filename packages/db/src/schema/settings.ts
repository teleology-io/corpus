import { jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { updatedAt, userRef } from './_helpers';

/**
 * Per-user overrides of registry-defined settings (apps/web/src/lib/settings.ts). Only changed
 * settings get a row; a missing row means the registry default. Values are validated against the
 * setting's definition on write and again on read.
 */
export const userSettings = pgTable(
	'user_settings',
	{
		userId: userRef('user_id').notNull(),
		key: text('key').notNull(),
		value: jsonb('value').$type<unknown>().notNull(),
		updatedAt: updatedAt()
	},
	(t) => [primaryKey({ columns: [t.userId, t.key] })]
);
