import { eq } from 'drizzle-orm';
import { decrypt, encrypt } from '@corpus/core/crypto';
import { getProvider, serviceAccountToken } from '@corpus/core/integrations';
import { encryptionKey, oauthConfig } from './apps';
import { db } from './index';
import { integrationConnection as conn } from './schema/index';

type Conn = typeof conn.$inferSelect;

export { encryptionKey, oauthConfig } from './apps';

/** Decrypted access token, refreshed (and persisted) when it's about to expire. */
export async function accessToken(c: Conn): Promise<string> {
	const key = encryptionKey();
	const token = decrypt(c.accessToken, key);
	const expiring = c.tokenExpiresAt && c.tokenExpiresAt.getTime() < Date.now() + 60_000;
	if (!expiring || !c.refreshToken) return token;
	let next;
	if (c.authType === 'service_account') {
		// refreshToken holds the encrypted service account credential; mint a new token from it.
		next = await serviceAccountToken(JSON.parse(decrypt(c.refreshToken, key)));
	} else {
		const provider = getProvider(c.provider);
		const cfg = await oauthConfig(c.provider);
		if (!provider?.refresh || !cfg) return token;
		next = await provider.refresh(cfg, decrypt(c.refreshToken, key));
	}
	await db
		.update(conn)
		.set({
			accessToken: encrypt(next.accessToken, key),
			refreshToken: next.refreshToken ? encrypt(next.refreshToken, key) : c.refreshToken,
			tokenExpiresAt: next.expiresAt ?? null
		})
		.where(eq(conn.id, c.id));
	return next.accessToken;
}
