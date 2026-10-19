import { customType, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organization, user } from './auth';

export const id = () => uuid('id').primaryKey().defaultRandom();
export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
export const createdAt = () => tstz('created_at').defaultNow().notNull();
export const updatedAt = () =>
	tstz('updated_at')
		.defaultNow()
		.notNull()
		.$onUpdate(() => new Date());

export const workspaceRef = () =>
	text('workspace_id')
		.notNull()
		.references(() => organization.id, { onDelete: 'cascade' });

export const userRef = (name: string) =>
	text(name).references(() => user.id, { onDelete: 'cascade' });

export const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
	dataType: () => 'bytea',
	toDriver: (v) => Buffer.from(v),
	fromDriver: (v) => new Uint8Array(v)
});
