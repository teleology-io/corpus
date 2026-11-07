import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERSONAS, crosscheckPrompt, reviewPrompt } from '../../src/lib/server/pr-review/prompts';
import {
	MAX_PERSONA_LENGTH,
	normalizeReviewerSettings,
	readReviewerSettings,
	writeReviewerSettings
} from '../../src/lib/server/pr-review/reviewers';
import { reviewEnv } from '../../src/lib/server/pr-review/runner';

describe('normalizeReviewerSettings', () => {
	it('accepts aliases, Bedrock ids and ARNs', () => {
		for (const model of [
			'sonnet[1m]',
			'us.anthropic.claude-opus-5-5-v1:0',
			'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-5-5-v1:0'
		])
			expect(normalizeReviewerSettings({ integrator: { model } }).integrator.model).toBe(model);
	});

	it('refuses a model that could be read as a CLI flag', () => {
		expect(() =>
			normalizeReviewerSettings({ breaker: { model: '--dangerously-skip-permissions' } })
		).toThrow('model ID');
		expect(() => normalizeReviewerSettings({ breaker: { model: 'a b' } })).toThrow('model ID');
	});

	it('treats a blank or unchanged persona as the built-in one, even with CRLF', () => {
		const unchanged = PERSONAS.breaker.replaceAll('\n', '\r\n');
		const out = normalizeReviewerSettings({
			integrator: { persona: '   ' },
			breaker: { persona: unchanged }
		});
		expect(out.integrator.persona).toBeNull();
		expect(out.breaker.persona).toBeNull();
	});

	it('keeps a custom persona and refuses an oversized one', () => {
		expect(
			normalizeReviewerSettings({ integrator: { persona: ' Be strict. ' } }).integrator.persona
		).toBe('Be strict.');
		expect(() =>
			normalizeReviewerSettings({
				integrator: { persona: 'x'.repeat(MAX_PERSONA_LENGTH + 1) }
			})
		).toThrow('persona');
	});
});

describe('reviewer settings file', () => {
	it('round-trips, and falls back to defaults when missing or damaged', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewers-'));
		const file = path.join(dir, 'nested', 'settings.json');
		const empty = { model: '', persona: null };
		const defaults = { integrator: empty, breaker: empty, voice: empty };
		expect(readReviewerSettings(file)).toEqual(defaults);

		const saved = normalizeReviewerSettings({
			integrator: { model: 'opus', persona: 'Mine' },
			voice: { model: 'haiku', persona: 'Blunt, lowercase.' }
		});
		writeReviewerSettings(file, saved);
		expect(readReviewerSettings(file)).toEqual(saved);

		fs.writeFileSync(file, '{ not json');
		expect(readReviewerSettings(file)).toEqual(defaults);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('reads a file saved before voices existed as no voice', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewers-'));
		const file = path.join(dir, 'settings.json');
		fs.writeFileSync(file, JSON.stringify({ integrator: { model: 'opus', persona: null } }));
		expect(readReviewerSettings(file).voice).toEqual({ model: '', persona: null });
		fs.rmSync(dir, { recursive: true, force: true });
	});
});

describe('voice settings', () => {
	it('treats a blank voice as off and validates it like a reviewer', () => {
		expect(normalizeReviewerSettings({ voice: { persona: '  ' } }).voice.persona).toBeNull();
		expect(normalizeReviewerSettings({ voice: { persona: ' Terse. ' } }).voice.persona).toBe(
			'Terse.'
		);
		expect(() => normalizeReviewerSettings({ voice: { model: '--flag' } })).toThrow('model ID');
		expect(() =>
			normalizeReviewerSettings({ voice: { persona: 'x'.repeat(MAX_PERSONA_LENGTH + 1) } })
		).toThrow('voice persona');
	});
});

describe('custom personas in prompts', () => {
	it('replaces only the persona, keeping the method and safety rules', () => {
		const round1 = reviewPrompt('breaker', '/b', 'merged', 'Be strict.');
		expect(round1.startsWith('Be strict.')).toBe(true);
		expect(round1).not.toContain(PERSONAS.breaker);
		expect(round1).toContain('UNTRUSTED CONTENT');
		expect(round1).toContain('review-findings');

		const round2 = crosscheckPrompt('breaker', '/b', 'merged', [], 'Be strict.');
		expect(round2.startsWith('Be strict.')).toBe(true);
		expect(round2).toContain('UNTRUSTED CONTENT');
		expect(round2).toContain('review-crosscheck');
	});

	it('uses the built-in persona when none is set', () => {
		expect(reviewPrompt('integrator', '/b', 'merged', null)).toContain(PERSONAS.integrator);
	});
});

describe('reviewEnv for Bedrock', () => {
	it('passes AWS credentials and Bedrock config, but not server secrets', () => {
		const env = reviewEnv({
			CLAUDE_CODE_USE_BEDROCK: '1',
			AWS_REGION: 'us-east-1',
			AWS_PROFILE: 'work',
			AWS_ACCESS_KEY_ID: 'id',
			AWS_SECRET_ACCESS_KEY: 'secret',
			AWS_SESSION_TOKEN: 'token',
			AWS_BEARER_TOKEN_BEDROCK: 'bearer',
			HTTPS_PROXY: 'http://proxy',
			NODE_EXTRA_CA_CERTS: '/ca.pem',
			DATABASE_URL: 'postgres://secret',
			GITHUB_TOKEN: 'g'
		});
		expect(env).toEqual({
			CLAUDE_CODE_USE_BEDROCK: '1',
			AWS_REGION: 'us-east-1',
			AWS_PROFILE: 'work',
			AWS_ACCESS_KEY_ID: 'id',
			AWS_SECRET_ACCESS_KEY: 'secret',
			AWS_SESSION_TOKEN: 'token',
			AWS_BEARER_TOKEN_BEDROCK: 'bearer',
			HTTPS_PROXY: 'http://proxy',
			NODE_EXTRA_CA_CERTS: '/ca.pem'
		});
	});
});
