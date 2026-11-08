import { describe, expect, it } from 'vitest';
import { buildSlackQuery, parseSlackQuery } from '../../src/lib/slack-query';

describe('slack search query', () => {
	it('composes modifiers', () => {
		expect(
			buildSlackQuery({
				text: 'deploy',
				in: 'general',
				from: 'alice',
				after: '2026-01-01',
				before: '2026-02-01'
			})
		).toBe('deploy in:#general from:@alice after:2026-01-01 before:2026-02-01');
	});

	it('keeps explicit prefixes and drops bad dates', () => {
		expect(buildSlackQuery({ in: '@bob', from: '<@U1>', after: 'yesterday' })).toBe(
			'in:@bob from:<@U1>'
		);
	});

	it('round-trips', () => {
		const q = 'release notes in:#eng from:@alice after:2026-03-01';
		expect(buildSlackQuery(parseSlackQuery(q))).toBe(q);
	});
});
