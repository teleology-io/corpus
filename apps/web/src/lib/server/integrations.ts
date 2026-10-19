import { error } from '@sveltejs/kit';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db, schema, sql } from '@corpus/db';
import { accessToken, encryptionKey, oauthConfig } from '@corpus/db/connections';
import { isInstanceAdmin } from '@corpus/db/apps';
import { encrypt } from '@corpus/core/crypto';
import {
	GoogleApiError,
	ProviderAuthError,
	envPrefix,
	gcal,
	getProvider,
	type OAuthConfig,
	type Provider
} from '@corpus/core/integrations';
import type { IntegrationItemDTO } from '#lib/types.js';

const { integrationConnection: conn, integrationItem: item } = schema;

/** Worker listens on this channel and polls the named connection immediately. */
export const POLL_CHANNEL = 'corpus_poll';

export { oauthConfig, envPrefix };

export async function requireProvider(
	id: string
): Promise<{ provider: Provider; cfg: OAuthConfig }> {
	const provider = getProvider(id);
	if (!provider) error(404, 'Unknown integration');
	const cfg = await oauthConfig(id);
	if (!cfg) error(503, `${provider.name} isn't set up yet — an admin can add its OAuth app.`);
	return { provider, cfg };
}

export async function requireAdmin(user: { id: string; email: string }) {
	if (!(await isInstanceAdmin(user))) error(403, 'Only an admin can manage integration apps');
}

/** Connects with a user-pasted personal token / API key (no OAuth app needed). */
export async function connectWithToken(userId: string, providerId: string, token: string) {
	const provider = getProvider(providerId);
	if (!provider?.personalToken) error(400, 'This integration only supports OAuth');
	let account;
	try {
		account = await provider.account(token);
	} catch (e) {
		if (e instanceof ProviderAuthError) error(400, `${provider.name} rejected that token`);
		throw e;
	}
	return saveConnection(userId, providerId, { accessToken: token }, account, 'token');
}

/** Integrations are per user (workspace_id stays null until org integrations exist). */
export async function listConnections(userId: string) {
	return db
		.select({
			id: conn.id,
			provider: conn.provider,
			accountLogin: conn.accountLogin,
			accountAvatar: conn.accountAvatar,
			authType: conn.authType,
			status: conn.status,
			lastError: conn.lastError,
			lastPolledAt: conn.lastPolledAt,
			pollIntervalSec: conn.pollIntervalSec,
			settings: conn.settings,
			createdAt: conn.createdAt
		})
		.from(conn)
		.where(eq(conn.userId, userId));
}

export async function saveConnection(
	userId: string,
	providerId: string,
	tokens: {
		accessToken: string;
		refreshToken?: string | null;
		expiresAt?: Date | null;
		scopes?: string | null;
	},
	account: { login: string; avatarUrl?: string | null },
	authType: 'oauth' | 'token' = 'oauth'
) {
	const key = encryptionKey();
	const values = {
		accessToken: encrypt(tokens.accessToken, key),
		refreshToken: tokens.refreshToken ? encrypt(tokens.refreshToken, key) : null,
		tokenExpiresAt: tokens.expiresAt ?? null,
		scopes: tokens.scopes ?? null,
		accountLogin: account.login,
		accountAvatar: account.avatarUrl ?? null,
		authType,
		status: 'active',
		lastError: null,
		nextPollAt: new Date()
	};
	const [row] = await db
		.insert(conn)
		.values({ userId, provider: providerId, ...values })
		.onConflictDoUpdate({ target: [conn.userId, conn.provider], set: values })
		.returning({ id: conn.id });
	await requestPoll(row!.id);
	return row!;
}

export async function requestPoll(connectionId: string) {
	await db.update(conn).set({ nextPollAt: new Date() }).where(eq(conn.id, connectionId));
	await sql.notify(POLL_CHANNEL, connectionId);
}

export async function ownConnection(userId: string, id: string) {
	const [row] = await db
		.select()
		.from(conn)
		.where(and(eq(conn.id, id), eq(conn.userId, userId)))
		.limit(1);
	if (!row) error(404, 'Connection not found');
	return row;
}

export async function updateConnectionSettings(
	userId: string,
	id: string,
	settings: { syncTasks?: boolean; notify?: boolean; calendars?: string[] }
) {
	const row = await ownConnection(userId, id);
	await db
		.update(conn)
		.set({ settings: { ...row.settings, ...settings } })
		.where(eq(conn.id, id));
	if (settings.calendars) await requestPoll(id);
}

/** The user's Google calendars, flagged with which ones are mirrored into Corpus. */
export async function googleCalendars(userId: string, id: string) {
	const row = await ownConnection(userId, id);
	if (row.provider !== 'google-calendar') error(400, 'Not a Google Calendar connection');
	let list: Awaited<ReturnType<typeof gcal.calendars>>;
	try {
		list = await gcal.calendars(await accessToken(row));
	} catch (e) {
		if (e instanceof ProviderAuthError) error(409, 'Google Calendar needs to be reconnected');
		if (e instanceof GoogleApiError) error(502, `Google: ${e.message}`);
		throw e;
	}
	const selected = row.settings.calendars ?? list.filter((c) => c.primary).map((c) => c.id);
	return list
		.map((c) => ({
			id: c.id,
			name: c.summaryOverride ?? c.summary,
			color: c.backgroundColor ?? '#2C87F2',
			primary: !!c.primary,
			readOnly: c.accessRole !== 'owner' && c.accessRole !== 'writer',
			selected: selected.includes(c.id)
		}))
		.sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
}

export async function disconnect(userId: string, id: string) {
	await ownConnection(userId, id);
	await db.delete(conn).where(eq(conn.id, id));
}

export async function openItems(
	userId: string,
	opts: { provider?: string; limit?: number } = {}
): Promise<IntegrationItemDTO[]> {
	const rows = await db
		.select({
			id: item.id,
			provider: conn.provider,
			kind: item.kind,
			title: item.title,
			subtitle: item.subtitle,
			url: item.url,
			state: item.state,
			updatedAt: item.externalUpdatedAt,
			payload: item.payload
		})
		.from(item)
		.innerJoin(conn, eq(item.connectionId, conn.id))
		.where(
			and(
				eq(conn.userId, userId),
				isNull(item.resolvedAt),
				opts.provider ? eq(conn.provider, opts.provider) : undefined
			)
		)
		.orderBy(desc(item.externalUpdatedAt))
		.limit(opts.limit ?? 100);
	return rows.map((r) => ({ ...r, updatedAt: r.updatedAt?.toISOString() ?? null }));
}
