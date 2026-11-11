import { describe, expect, it } from 'vitest';
import type { Finding } from '../../src/lib/server/pr-review/findings';
import { buildGithubReview } from '../../src/lib/server/pr-review/post';

const patch = [
	'diff --git a/x.ts b/x.ts',
	'--- a/x.ts',
	'+++ b/x.ts',
	'@@ -1 +1,2 @@',
	' a',
	'+b'
].join('\n');

const finding = (over: Partial<Finding> = {}): Finding => ({
	id: 'breaker:a',
	severity: 'major',
	category: 'correctness',
	file: 'x.ts',
	line: 2,
	title: 'Bad',
	trigger: 'T',
	impact: 'I',
	evidence: [],
	fix: 'F',
	reviewer: 'breaker',
	...over
});

describe('buildGithubReview', () => {
	it('anchors to diff lines', () => {
		const out = buildGithubReview([finding()], patch);
		expect(out.comments.map((c) => [c.path, c.line])).toEqual([['x.ts', 2]]);
	});

	it('keeps findings that cannot anchor in the body', () => {
		const out = buildGithubReview(
			[
				finding({ line: 99, title: 'Off diff' }),
				finding({ file: 'other.ts', title: 'Other file' }),
				finding({ file: '', line: null, title: 'No file' })
			],
			patch
		);
		expect(out.comments).toEqual([]);
		for (const title of ['Off diff', 'Other file', 'No file']) expect(out.body).toContain(title);
		expect(out.ids).toHaveLength(3);
	});

	it('leaves out dropped and dismissed findings', () => {
		const out = buildGithubReview(
			[finding({ dropped: { evidence: ['x'] } }), finding({ outcome: 'dismissed' })],
			patch
		);
		expect(out.ids).toEqual([]);
		expect(out.comments).toEqual([]);
	});

	it('posts your own comment verbatim in place of the finding', () => {
		const built = buildGithubReview(
			[finding({ custom: 'Nit: @sam can we rename this?', voiced: 'Voiced' })],
			patch
		);
		expect(built.comments[0].body).toBe('Nit: @sam can we rename this?');
	});

	it('labels disputed findings', () => {
		expect(buildGithubReview([finding({ disputed: true })], patch).comments[0].body).toContain(
			'(disputed)'
		);
	});

	it('posts the voiced text with a severity label the voice cannot change', () => {
		const body = buildGithubReview(
			[finding({ severity: 'blocker', disputed: true, voiced: 'this one will bite you' })],
			patch
		).comments[0].body;
		expect(body).toBe('**blocker (disputed)**\n\nthis one will bite you');
	});

	it('keeps voiced findings that cannot anchor in the body', () => {
		const out = buildGithubReview([finding({ line: 99, voiced: 'off the diff, sorry' })], patch);
		expect(out.comments).toEqual([]);
		expect(out.body).toContain('off the diff, sorry');
	});

	it('cannot ping anyone from voiced text', () => {
		const out = buildGithubReview([finding({ voiced: 'cc @octocat' })], patch);
		expect(out.comments[0].body).not.toMatch(/@[\w-]/);
	});

	it('cannot ping anyone from reviewer text', () => {
		const out = buildGithubReview([finding({ title: 'cc @octocat and @org/team' })], patch);
		expect(out.comments[0].body).not.toMatch(/@[\w-]/);
	});
});
