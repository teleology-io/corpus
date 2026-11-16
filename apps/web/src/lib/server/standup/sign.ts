import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@corpus/db';
import type { StandupSnapshot } from '#lib/standup/model.js';

/** Snapshots travel through the client (any server process can verify them), so they're signed. */
export const SNAPSHOT_TTL_MS = 30 * 60 * 1000;
export const MAX_SNAPSHOT_BYTES = 256 * 1024;

const secret = () =>
	`standup:${env('BETTER_AUTH_SECRET', 'dev-secret-change-me-dev-secret-change-me')}`;
const mac = (payload: string) => createHmac('sha256', secret()).update(payload).digest('base64url');

/** The exact string that was signed is what comes back, so no canonical JSON is needed. */
export function signSnapshot(snapshot: StandupSnapshot) {
	const payload = JSON.stringify(snapshot);
	return { payload, signature: mac(payload) };
}

export type Verified =
	{ ok: true; snapshot: StandupSnapshot } | { ok: false; status: number; message: string };

export function verifySnapshot(
	userId: string,
	payload: string,
	signature: string,
	now = Date.now()
): Verified {
	if (Buffer.byteLength(payload) > MAX_SNAPSHOT_BYTES)
		return { ok: false, status: 413, message: 'Standup evidence is too large' };
	const expected = Buffer.from(mac(payload));
	const given = Buffer.from(String(signature));
	if (expected.length !== given.length || !timingSafeEqual(expected, given))
		return { ok: false, status: 400, message: 'Standup evidence failed verification' };
	const snapshot = JSON.parse(payload) as StandupSnapshot;
	if (snapshot.userId !== userId)
		return { ok: false, status: 403, message: 'Standup evidence belongs to another user' };
	if (Date.parse(snapshot.expiresAt) <= now)
		return { ok: false, status: 410, message: 'Standup evidence expired. Refresh it.' };
	return { ok: true, snapshot };
}
