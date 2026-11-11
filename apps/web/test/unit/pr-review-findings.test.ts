import { describe, expect, it } from 'vitest';
import {
	applyCrosscheck,
	finalStatus,
	liveBlockers,
	parseCrosscheck,
	parseReview,
	uniqueIds,
	type Finding,
	type ReviewerResult
} from '../../src/lib/server/pr-review/findings';

const fenced = (tag: string, value: unknown) =>
	'```' + tag + '\n' + JSON.stringify(value) + '\n```';

const rawFinding = {
	id: 'race',
	severity: 'blocker',
	category: 'reliability',
	file: 'a.ts',
	line: 3,
	title: 'Double charge on retry',
	trigger: 'Timeout then retry',
	impact: 'Customer charged twice',
	evidence: ['a.ts:3 has no idempotency key'],
	fix: 'Add a key'
};

const finding = (over: Partial<Finding> = {}): Finding => ({
	...rawFinding,
	severity: 'blocker',
	line: 3,
	id: 'breaker:race',
	reviewer: 'breaker',
	...over
});

const clean: ReviewerResult = { verdict: 'clean', notReviewed: [], findings: [], questions: [] };

describe('parseReview', () => {
	it('reads the last block, so quoted examples earlier do not win', () => {
		const text = `${fenced('review-findings', { verdict: 'clean', findings: [] })}\nthen\n${fenced('review-findings', { verdict: 'findings', findings: [rawFinding] })}`;
		const parsed = parseReview(text, 'breaker');
		expect(parsed?.findings[0].id).toBe('breaker:race');
	});

	it.each([
		['no block', 'Looks good to me'],
		['invalid JSON', '```review-findings\n{nope\n```'],
		['unknown verdict', fenced('review-findings', { verdict: 'lgtm', findings: [] })],
		['missing findings', fenced('review-findings', { verdict: 'clean' })],
		[
			'bad severity',
			fenced('review-findings', {
				verdict: 'findings',
				findings: [{ ...rawFinding, severity: 'huge' }]
			})
		],
		['clean with findings', fenced('review-findings', { verdict: 'clean', findings: [rawFinding] })]
	])('returns null for %s', (_, text) => {
		expect(parseReview(text, 'breaker')).toBeNull();
	});

	it('keeps skipped paths', () => {
		const parsed = parseReview(
			fenced('review-findings', {
				verdict: 'clean',
				findings: [],
				coverage: { not_reviewed: [{ path: 'b.ts', reason: 'too large' }] }
			}),
			'integrator'
		);
		expect(parsed?.notReviewed).toEqual([{ path: 'b.ts', reason: 'too large' }]);
	});
});

describe('applyCrosscheck', () => {
	const refuted = (evidence: string[]) => [
		{ id: 'breaker:race', status: 'refuted' as const, uncertain: false, evidence }
	];

	it('drops a blocker on a refutation with evidence and keeps it visible', () => {
		const [out] = applyCrosscheck([finding()], refuted(['a.ts:1 lock prevents this']));
		expect(out.dropped?.evidence).toEqual(['a.ts:1 lock prevents this']);
		expect(liveBlockers([out])).toEqual([]);
	});

	it('keeps a blocker when the refutation has no evidence', () => {
		const [out] = applyCrosscheck([finding()], refuted([]));
		expect(out.dropped).toBeUndefined();
		expect(out.disputed).toBe(true);
	});

	it('keeps a blocker when the crosscheck failed or skipped it', () => {
		expect(applyCrosscheck([finding()], null)[0].disputed).toBe(true);
		expect(applyCrosscheck([finding()], [])[0].disputed).toBe(true);
	});

	it('marks uncertain confirmations disputed and leaves confirmed ones alone', () => {
		const result = (uncertain: boolean) => [
			{ id: 'breaker:race', status: 'confirmed' as const, uncertain, evidence: [] }
		];
		expect(applyCrosscheck([finding()], result(true))[0].disputed).toBe(true);
		expect(applyCrosscheck([finding()], result(false))[0].disputed).toBeUndefined();
	});

	it('does not touch non-blockers', () => {
		const minor = finding({ severity: 'minor' });
		expect(applyCrosscheck([minor], null)[0]).toEqual(minor);
	});

	it('defaults an unknown crosscheck status to confirmed', () => {
		const results = parseCrosscheck(
			fenced('review-crosscheck', { results: [{ id: 'breaker:race', status: 'maybe' }] })
		);
		expect(results?.[0].status).toBe('confirmed');
	});
});

describe('finalStatus', () => {
	it('fails when a reviewer did not produce a result', () => {
		expect(finalStatus({ results: [clean, null], partial: false, findings: [] })).toBe('failed');
		expect(finalStatus({ results: [clean], partial: false, findings: [] })).toBe('failed');
	});

	it('is never clean when coverage is incomplete', () => {
		expect(finalStatus({ results: [clean, clean], partial: true, findings: [] })).toBe('partial');
		const skipped = { ...clean, notReviewed: [{ path: 'b.ts', reason: 'large' }] };
		expect(finalStatus({ results: [clean, skipped], partial: false, findings: [] })).toBe(
			'partial'
		);
	});

	it('reports partial even with findings', () => {
		expect(finalStatus({ results: [clean, clean], partial: true, findings: [finding()] })).toBe(
			'partial'
		);
	});

	it('is clean only when complete and nothing stands', () => {
		expect(finalStatus({ results: [clean, clean], partial: false, findings: [] })).toBe('clean');
		const dropped = finding({ dropped: { evidence: ['x'] } });
		expect(finalStatus({ results: [clean, clean], partial: false, findings: [dropped] })).toBe(
			'clean'
		);
		expect(finalStatus({ results: [clean, clean], partial: false, findings: [finding()] })).toBe(
			'findings'
		);
	});
});

describe('uniqueIds', () => {
	it('numbers repeated ids so each finding can be addressed alone', () => {
		const ids = uniqueIds([
			finding({ id: 'breaker:x' }),
			finding({ id: 'breaker:x' }),
			finding({ id: 'breaker:y' }),
			finding({ id: 'breaker:x' })
		]).map((f) => f.id);
		expect(ids).toEqual(['breaker:x', 'breaker:x#2', 'breaker:y', 'breaker:x#3']);
	});

	it('gives parsed findings distinct ids when the reviewer repeats one', () => {
		const text = fenced('review-findings', {
			verdict: 'findings',
			findings: [rawFinding, { ...rawFinding, title: 'Another' }]
		});
		expect(parseReview(text, 'breaker')?.findings.map((f) => f.id)).toEqual([
			'breaker:race',
			'breaker:race#2'
		]);
	});
});
