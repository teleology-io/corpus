import { relations, sql } from 'drizzle-orm';
import {
	boolean,
	doublePrecision,
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
	/** Slack: days of cached message history to keep (default 30) */
	slackRetentionDays?: number;
	/**
	 * Slack: which conversations.history/replies limits apply. `internal` = workspace-built app
	 * (Tier 3), `distributed` = unlisted distributed app (1 req/min, 15 per page), `auto` learns
	 * from 429s.
	 */
	slackRateProfile?: 'auto' | 'internal' | 'distributed';
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
		 * service_account (Google key file; refresh_token holds the encrypted credential) |
		 * ical (Google secret iCal addresses; access_token holds the encrypted `{ feeds }` JSON)
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
		/** Consecutive failed polls (exponential backoff); reset on success */
		failureCount: integer('failure_count').notNull().default(0),
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
	(t) => [
		uniqueIndex('integration_item_unique').on(t.connectionId, t.externalId),
		// Open items, newest first (dashboard, integrations page, search)
		index('integration_item_open_idx')
			.on(t.connectionId, t.externalUpdatedAt)
			.where(sql`${t.resolvedAt} is null`)
	]
);

/** One Integration Review of one head commit of someone else's pull request. */
export const prReview = pgTable(
	'pr_review',
	{
		id: id(),
		itemId: uuid('item_id')
			.notNull()
			.references(() => integrationItem.id, { onDelete: 'cascade' }),
		userId: userRef('user_id').notNull(),
		headSha: text('head_sha').notNull(),
		/** The commit reviewers read: GitHub's test merge when available, otherwise the head. */
		treeSha: text('tree_sha'),
		/** running | clean | findings | partial | failed | interrupted | stale */
		status: text('status').notNull().default('running'),
		slots: jsonb('slots').$type<{ provider: string; model: string }[]>().notNull().default([]),
		notices: jsonb('notices').$type<string[]>().notNull().default([]),
		costUsd: doublePrecision('cost_usd').notNull().default(0),
		findings: jsonb('findings').$type<Record<string, unknown>[]>().notNull().default([]),
		questions: jsonb('questions').$type<string[]>().notNull().default([]),
		notReviewed: jsonb('not_reviewed')
			.$type<{ path: string; reason: string }[]>()
			.notNull()
			.default([]),
		error: text('error'),
		postedUrl: text('posted_url'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		uniqueIndex('pr_review_item_head_unique').on(t.itemId, t.headSha),
		index('pr_review_user_idx').on(t.userId, t.createdAt)
	]
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

const connectionRef = () =>
	uuid('connection_id')
		.notNull()
		.references(() => integrationConnection.id, { onDelete: 'cascade' });

/** Cached Slack conversations (channels, private channels, DMs, group DMs) for one connection. */
export const slackConversation = pgTable(
	'slack_conversation',
	{
		id: id(),
		connectionId: connectionRef(),
		channelId: text('channel_id').notNull(),
		/** public | private | im | mpim */
		kind: text('kind').notNull(),
		name: text('name'),
		/** DM partner (kind = im) */
		dmUserId: text('dm_user_id'),
		topic: text('topic'),
		isMember: boolean('is_member').notNull().default(true),
		isArchived: boolean('is_archived').notNull().default(false),
		/** ts of the newest cached message (incremental sync cursor) */
		latestTs: text('latest_ts'),
		/** ts of the oldest cached message */
		oldestTs: text('oldest_ts'),
		/** Older history exists in Slack beyond oldestTs */
		hasOlder: boolean('has_older').notNull().default(true),
		lastReadTs: text('last_read_ts'),
		/** DMs: newest message ts per conversations.info (may be ahead of the message cache) */
		remoteLatestTs: text('remote_latest_ts'),
		/** DMs: Slack's own read marker (reading in Slack clears unread here too) */
		slackLastRead: text('slack_last_read'),
		/** DMs: last conversations.info check (round-robin order) */
		checkedAt: tstz('checked_at'),
		/** Last time the user opened it in Corpus — drives background refresh */
		lastOpenedAt: tstz('last_opened_at'),
		lastSyncedAt: tstz('last_synced_at'),
		/** Slack error that stopped background polling (channel_not_found, not_in_channel…) */
		inaccessibleCode: text('inaccessible_code'),
		inaccessibleAt: tstz('inaccessible_at'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [uniqueIndex('slack_conversation_unique').on(t.connectionId, t.channelId)]
);

/** Cached Slack messages. (connection, channel, ts) is the dedupe key. */
export const slackMessage = pgTable(
	'slack_message',
	{
		id: id(),
		connectionId: connectionRef(),
		channelId: text('channel_id').notNull(),
		ts: text('ts').notNull(),
		/** Parent ts for thread replies and thread roots; null for plain channel messages */
		threadTs: text('thread_ts'),
		/** Seconds since epoch (ordering / retention) */
		tsNum: doublePrecision('ts_num').notNull(),
		userId: text('user_id'),
		botName: text('bot_name'),
		text: text('text').notNull().default(''),
		subtype: text('subtype'),
		replyCount: integer('reply_count').notNull().default(0),
		latestReply: text('latest_reply'),
		/** File metadata only — contents are never downloaded */
		files: jsonb('files')
			.$type<{ name: string; mimetype?: string; size?: number; url?: string }[]>()
			.notNull()
			.default([]),
		editedTs: text('edited_ts'),
		deletedAt: tstz('deleted_at'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		uniqueIndex('slack_message_unique').on(t.connectionId, t.channelId, t.ts),
		index('slack_message_channel_idx').on(t.connectionId, t.channelId, t.tsNum),
		index('slack_message_thread_idx').on(t.connectionId, t.channelId, t.threadTs, t.tsNum)
	]
);

/** Slack user display names / avatars per connection. */
export const slackUser = pgTable(
	'slack_user',
	{
		connectionId: connectionRef(),
		userId: text('user_id').notNull(),
		name: text('name').notNull(),
		image: text('image'),
		updatedAt: updatedAt()
	},
	(t) => [uniqueIndex('slack_user_unique').on(t.connectionId, t.userId)]
);

/**
 * Token bucket per (connection, Slack method), shared by the web app and the worker so both
 * stay under Slack's per-app, per-workspace, per-method limits.
 */
export const slackRateLimit = pgTable(
	'slack_rate_limit',
	{
		connectionId: connectionRef(),
		method: text('method').notNull(),
		tokens: doublePrecision('tokens').notNull(),
		perMinute: doublePrecision('per_minute').notNull(),
		refilledAt: tstz('refilled_at').notNull().defaultNow(),
		/** Slack said Retry-After: nothing goes out before this */
		blockedUntil: tstz('blocked_until')
	},
	(t) => [uniqueIndex('slack_rate_limit_unique').on(t.connectionId, t.method)]
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
