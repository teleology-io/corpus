import { asc, eq } from 'drizzle-orm';
import { decrypt, encrypt } from '@corpus/core/crypto';
import { envPrefix, type OAuthConfig } from '@corpus/core/integrations';
import { env, optionalEnv } from './env';
import { db } from './index';
import { integrationApp as app, user } from './schema/index';

export const encryptionKey = () =>
	env('ENCRYPTION_KEY', env('BETTER_AUTH_SECRET', 'dev-secret-change-me-dev-secret-change-me'));

export const redirectUri = (providerId: string) =>
	`${env('PUBLIC_APP_URL', 'http://localhost:5173')}/integrations/${providerId}/callback`;

/** Where a provider's OAuth app credentials come from, if anywhere. */
export type OAuthAppSource = 'env' | 'db' | null;

function fromEnv(providerId: string) {
	const prefix = envPrefix(providerId);
	const clientId = optionalEnv(`${prefix}_CLIENT_ID`);
	const clientSecret = optionalEnv(`${prefix}_CLIENT_SECRET`);
	return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** OAuth app credentials: `{PREFIX}_CLIENT_ID` / `_SECRET` env first, then admin-entered. */
export async function oauthConfig(providerId: string): Promise<OAuthConfig | null> {
	const creds = fromEnv(providerId) ?? (await stored(providerId));
	return creds && { ...creds, redirectUri: redirectUri(providerId) };
}

async function stored(providerId: string) {
	const [row] = await db.select().from(app).where(eq(app.provider, providerId)).limit(1);
	return row
		? { clientId: row.clientId, clientSecret: decrypt(row.clientSecret, encryptionKey()) }
		: null;
}

/** Per-provider source + client id (never the secret), for the admin setup UI. */
export async function oauthApps(providerIds: string[]) {
	const rows = await db.select({ provider: app.provider, clientId: app.clientId }).from(app);
	return Object.fromEntries(
		providerIds.map((id) => {
			const e = fromEnv(id);
			const row = rows.find((r) => r.provider === id);
			const source: OAuthAppSource = e ? 'env' : row ? 'db' : null;
			return [id, { source, clientId: e?.clientId ?? row?.clientId ?? null }];
		})
	);
}

export async function saveOAuthApp(
	providerId: string,
	creds: { clientId: string; clientSecret: string },
	userId: string
) {
	const values = {
		clientId: creds.clientId,
		clientSecret: encrypt(creds.clientSecret, encryptionKey()),
		updatedBy: userId
	};
	await db
		.insert(app)
		.values({ provider: providerId, ...values })
		.onConflictDoUpdate({ target: app.provider, set: values });
}

export async function deleteOAuthApp(providerId: string) {
	await db.delete(app).where(eq(app.provider, providerId));
}

/**
 * Instance admins manage OAuth apps. `ADMIN_EMAILS` (comma-separated) when set; otherwise
 * the first account created on this instance.
 */
export async function isInstanceAdmin(u: { id: string; email: string }) {
	const list = optionalEnv('ADMIN_EMAILS');
	if (list)
		return list
			.split(',')
			.map((e) => e.trim().toLowerCase())
			.includes(u.email.toLowerCase());
	const [first] = await db.select({ id: user.id }).from(user).orderBy(asc(user.createdAt)).limit(1);
	return first?.id === u.id;
}
