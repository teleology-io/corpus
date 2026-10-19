import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual
} from 'node:crypto';

function keyFrom(secret: string): Buffer {
	const raw = Buffer.from(secret, 'base64');
	return raw.length === 32 ? raw : createHash('sha256').update(secret).digest();
}

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext> (base64url). */
export function encrypt(plain: string, secret: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
	const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return ['v1', iv, tag, ct]
		.map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
		.join('.');
}

export function decrypt(payload: string, secret: string): string {
	const [version, iv, tag, ct] = payload.split('.');
	if (version !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported ciphertext');
	const decipher = createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64url'));
	decipher.setAuthTag(Buffer.from(tag, 'base64url'));
	return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString(
		'utf8'
	);
}

export function randomToken(bytes = 24) {
	return randomBytes(bytes).toString('base64url');
}

/** Compact signed token (HMAC-SHA256) — used to authorize collab websocket connections. */
export function signToken(payload: Record<string, unknown>, secret: string, ttlSec = 300): string {
	const body = Buffer.from(
		JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })
	).toString('base64url');
	const sig = createHmac('sha256', secret).update(body).digest('base64url');
	return `${body}.${sig}`;
}

export function verifyToken<T extends Record<string, unknown>>(
	token: string,
	secret: string
): T | null {
	const [body, sig] = token.split('.');
	if (!body || !sig) return null;
	const expected = createHmac('sha256', secret).update(body).digest();
	const given = Buffer.from(sig, 'base64url');
	if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
	const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & {
		exp: number;
	};
	return payload.exp * 1000 > Date.now() ? payload : null;
}
