import { index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, tstz, updatedAt, userRef } from './_helpers';
import { integrationItem } from './integrations';

/**
 * Conductor: one card per piece of work the user's day moves through (a ticket or someone else's
 * PR to review). Cards are seeded from integration items; the column is the user's (or, later, the
 * automation's) decision, not derived, so moving a card is a write.
 */
export const conductorCard = pgTable(
	'conductor_card',
	{
		id: id(),
		userId: userRef('user_id').notNull(),
		itemId: uuid('item_id')
			.notNull()
			.references(() => integrationItem.id, { onDelete: 'cascade' }),
		/** ticket | review */
		kind: text('kind').notNull(),
		/** inbox | today | working | ready | done */
		column: text('column').notNull().default('inbox'),
		/** Day (YYYY-MM-DD, user's local) the card was planned for. */
		plannedFor: text('planned_for'),
		/** Workbench chat working the ticket. */
		chatId: text('chat_id'),
		/** The PR an agent opened for a ticket. */
		prUrl: text('pr_url'),
		/** Last thing the user said when sending it back. */
		note: text('note'),
		meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
		/** Cleared off the board from Done. The row stays so the item isn't seeded again. */
		clearedAt: tstz('cleared_at'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		uniqueIndex('conductor_card_item_unique').on(t.userId, t.itemId),
		index('conductor_card_user_idx').on(t.userId, t.column)
	]
);

/** Timeline of what happened to cards: the activity rail and, later, the audit log for full-auto. */
export const conductorEvent = pgTable(
	'conductor_event',
	{
		id: id(),
		userId: userRef('user_id').notNull(),
		cardId: uuid('card_id').references(() => conductorCard.id, { onDelete: 'cascade' }),
		/** planned | moved | started | ready | sent_back | shipped | reviewed | plan_confirmed */
		kind: text('kind').notNull(),
		text: text('text').notNull(),
		/** you | conductor | <agent name> */
		actor: text('actor').notNull().default('you'),
		at: tstz('at').defaultNow().notNull()
	},
	(t) => [index('conductor_event_user_idx').on(t.userId, t.at)]
);
