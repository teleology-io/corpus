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
import { organization, user } from './auth';
import { createdAt, id, tstz, updatedAt, userRef } from './_helpers';

export interface ConnectionSettings {
	syncTasks?: boolean;
	notify?: boolean;
	/** Google Calendar: external calendar ids to mirror (default: primary) */
	calendars?: string[];
}

export const integrationConnection = pgTable(
	'integration_connection',
	{
		id: id(),
		/** Integrations are per user. Reserved for future org-level integrations (null = personal). */
		workspaceId: text('workspace_id').references(() => organization.id, { onDelete: 'cascade' }),
		userId: userRef('user_id').notNull(),
		/** github | linear | ... */
		provider: text('provider').notNull(),
		accountLogin: text('account_login'),
		accountAvatar: text('account_avatar'),
		/** AES-256-GCM encrypted */
		accessToken: text('access_token').notNull(),
		refreshToken: text('refresh_token'),
		tokenExpiresAt: tstz('token_expires_at'),
		scopes: text('scopes'),
		/**
		 * oauth (via the instance's OAuth app) | token (user-pasted personal token / API key) |
		 * service_account (Google key file; refresh_token holds the encrypted credential)
		 */
		authType: text('auth_type').notNull().default('oauth'),
		/** Provider-specific poll cursor (etag, last-modified, updatedAt...) */
		cursor: jsonb('cursor').$type<Record<string, string>>().notNull().default({}),
		pollIntervalSec: integer('poll_interval_sec').notNull().default(60),
		settings: jsonb('settings')
			.$type<ConnectionSettings>()
			.notNull()
			.default({ syncTasks: true, notify: true }),
		/** active | error | revoked */
		status: text('status').notNull().default('active'),
		lastError: text('last_error'),
		lastPolledAt: tstz('last_polled_at'),
		nextPollAt: tstz('next_poll_at'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		uniqueIndex('integration_connection_unique').on(t.userId, t.provider),
		index('integration_connection_poll_idx').on(t.status, t.nextPollAt)
	]
);

/**
 * Instance-wide OAuth app credentials entered by an admin in the UI. `{PREFIX}_CLIENT_ID` /
 * `_SECRET` env vars take precedence when set.
 */
export const integrationApp = pgTable('integration_app', {
	provider: text('provider').primaryKey(),
	clientId: text('client_id').notNull(),
	/** AES-256-GCM encrypted */
	clientSecret: text('client_secret').notNull(),
	updatedBy: text('updated_by').references(() => user.id, { onDelete: 'set null' }),
	createdAt: createdAt(),
	updatedAt: updatedAt()
});

export const integrationItem = pgTable(
	'integration_item',
	{
		id: id(),
		connectionId: uuid('connection_id')
			.notNull()
			.references(() => integrationConnection.id, { onDelete: 'cascade' }),
		externalId: text('external_id').notNull(),
		/** review_request | pull_request | issue | mention | notification */
		kind: text('kind').notNull(),
		title: text('title').notNull(),
		subtitle: text('subtitle'),
		url: text('url').notNull(),
		state: text('state'),
		/** Fingerprint of meaningful fields — changes trigger notifications */
		hash: text('hash').notNull(),
		externalUpdatedAt: tstz('external_updated_at'),
		payload: jsonb('payload').$type<Record<string, unknown>>(),
		/** Item no longer returned by the provider (closed, merged, unassigned) */
		resolvedAt: tstz('resolved_at'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [uniqueIndex('integration_item_unique').on(t.connectionId, t.externalId)]
);

/** Slack threads the user follows (auto-followed when mentioned, or opened by link). */
export const slackThread = pgTable(
	'slack_thread',
	{
		id: id(),
		connectionId: uuid('connection_id')
			.notNull()
			.references(() => integrationConnection.id, { onDelete: 'cascade' }),
		channelId: text('channel_id').notNull(),
		channelName: text('channel_name'),
		threadTs: text('thread_ts').notNull(),
		permalink: text('permalink'),
		/** Plain-text preview of the root message */
		preview: text('preview'),
		authorName: text('author_name'),
		replyCount: integer('reply_count').notNull().default(0),
		/** ts of the newest message we've seen */
		latestTs: text('latest_ts'),
		/** ts of the newest message the user has read in Corpus */
		lastReadTs: text('last_read_ts'),
		/** ts of the message that mentioned the user, if that's how it got here */
		mentionTs: text('mention_ts'),
		followed: boolean('followed').notNull().default(true),
		lastActivityAt: tstz('last_activity_at'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		uniqueIndex('slack_thread_unique').on(t.connectionId, t.channelId, t.threadTs),
		index('slack_thread_activity_idx').on(t.connectionId, t.lastActivityAt)
	]
);

export const integrationConnectionRelations = relations(integrationConnection, ({ many }) => ({
	items: many(integrationItem)
}));
export const integrationItemRelations = relations(integrationItem, ({ one }) => ({
	connection: one(integrationConnection, {
		fields: [integrationItem.connectionId],
		references: [integrationConnection.id]
	})
}));
