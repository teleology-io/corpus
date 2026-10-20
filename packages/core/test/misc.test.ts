import { generateKeyPairSync, createVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../src/crypto';
import { dedupeKey, inQuietHours, resolvePrefs } from '../src/notify';
import { diffItems, itemHash } from '../src/integrations/diff';
import type { ExternalItem } from '../src/integrations/types';
import { parseServiceAccount, serviceAccountAssertion } from '../src/integrations/google';

describe('crypto', () => {
	it('round-trips and rejects tampering', () => {
		const secret = 'test-secret';
		const enc = encrypt('gho_token', secret);
		expect(decrypt(enc, secret)).toBe('gho_token');
		const parts = enc.split('.');
		parts[3] = Buffer.from('nope').toString('base64url');
		expect(() => decrypt(parts.join('.'), secret)).toThrow();
	});
});

describe('notify', () => {
	it('builds stable dedupe keys', () => {
		expect(dedupeKey(['dose_due', 'c1', new Date('2026-01-01T08:00:00Z'), null])).toBe(
			'dose_due:c1:2026-01-01T08:00:00.000Z'
		);
	});
	it('merges prefs over defaults', () => {
		expect(resolvePrefs('dose_due', { push: false })).toEqual({
			inApp: true,
			push: false,
			email: false
		});
	});
	it('quiet hours across midnight', () => {
		expect(inQuietHours('23:30', '22:00', '07:00')).toBe(true);
		expect(inQuietHours('06:59', '22:00', '07:00')).toBe(true);
		expect(inQuietHours('07:00', '22:00', '07:00')).toBe(false);
		expect(inQuietHours('13:00', '12:00', '14:00')).toBe(true);
		expect(inQuietHours('13:00', null, null)).toBe(false);
	});
});

describe('diffItems', () => {
	const item = (id: string, state = 'open'): ExternalItem => ({
		externalId: id,
		kind: 'issue',
		title: id,
		url: 'u',
		state
	});
	it('classifies created, changed, resolved, reopened', () => {
		const existing = [
			{ id: '1', externalId: 'a', hash: itemHash(item('a')), resolvedAt: null },
			{ id: '2', externalId: 'b', hash: itemHash(item('b')), resolvedAt: null },
			{ id: '3', externalId: 'c', hash: itemHash(item('c')), resolvedAt: null },
			{ id: '4', externalId: 'd', hash: itemHash(item('d')), resolvedAt: new Date() }
		];
		const d = diffItems(existing, [item('a'), item('b', 'in review'), item('d'), item('e')]);
		expect(d.unchanged.map((i) => i.externalId)).toEqual(['a']);
		expect(d.changed.map((c) => c.item.externalId)).toEqual(['b']);
		expect(d.resolved.map((r) => r.externalId)).toEqual(['c']);
		expect(d.reopened.map((r) => r.item.externalId)).toEqual(['d']);
		expect(d.created.map((i) => i.externalId)).toEqual(['e']);
	});
});

describe('signed tokens', async () => {
	const { signToken, verifyToken } = await import('../src/crypto');
	it('verifies and rejects tampered/expired', () => {
		const t = signToken({ u: '1' }, 's');
		expect(verifyToken(t, 's')).toMatchObject({ u: '1' });
		expect(verifyToken(t, 'other')).toBeNull();
		expect(verifyToken(signToken({ u: '1' }, 's', -1), 's')).toBeNull();
	});
});

describe('google service account', () => {
	const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
	const file = JSON.stringify({
		type: 'service_account',
		client_email: 'sync@proj.iam.gserviceaccount.com',
		private_key: pem
	});

	it('validates key files', () => {
		expect(parseServiceAccount(file).client_email).toBe('sync@proj.iam.gserviceaccount.com');
		expect(() => parseServiceAccount('nope')).toThrow(/valid JSON/);
		expect(() => parseServiceAccount('{"type":"authorized_user"}')).toThrow(/service account/);
	});

	it('signs a verifiable RS256 assertion with optional subject', () => {
		const key = parseServiceAccount(file);
		const jwt = serviceAccountAssertion({ key, subject: 'me@corp.com' }, 1_700_000_000_000);
		const [h, c, sig] = jwt.split('.');
		const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
		expect(claims).toMatchObject({
			iss: key.client_email,
			sub: 'me@corp.com',
			aud: 'https://oauth2.googleapis.com/token',
			iat: 1_700_000_000,
			exp: 1_700_003_600
		});
		const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, sig!, 'base64url');
		expect(ok).toBe(true);
		const noSub = serviceAccountAssertion({ key });
		expect(
			JSON.parse(Buffer.from(noSub.split('.')[1]!, 'base64url').toString())
		).not.toHaveProperty('sub');
	});
});
