import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	commentableLines,
	parsePullRef,
	postPullReview,
	pullDetails,
	pullDiff
} from '@corpus/core/integrations';

const ref = { owner: 'acme', repo: 'api', number: 7 };

const route = (handler: (url: string, init: RequestInit) => Response) =>
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init: RequestInit) => handler(url, init))
	);

const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

const pull = (over = {}) => ({
	title: 'T',
	body: null,
	state: 'open',
	user: { login: 'stranger' },
	head: { sha: 'head1' },
	base: { sha: 'base1', ref: 'main' },
	merge_commit_sha: 'merge1',
	mergeable: true,
	...over
});

const detailsRoutes = (pr: unknown) => (url: string) => {
	if (url.endsWith('/pulls/7')) return ok(pr);
	if (url.includes('/check-runs')) return ok({ check_runs: [] });
	if (url.includes('/issues/7/comments'))
		return ok([
			{ user: { login: 'a' }, body: 'hi' },
			{ user: null, body: '  ' }
		]);
	return ok([]);
};

afterEach(() => vi.unstubAllGlobals());

describe('parsePullRef', () => {
	it('reads the stored subtitle and rejects anything else', () => {
		expect(parsePullRef('acme/api.js#7')).toEqual({ owner: 'acme', repo: 'api.js', number: 7 });
		expect(parsePullRef('acme/api')).toBeNull();
		expect(parsePullRef('../x/y#1/z')).toBeNull();
		expect(parsePullRef(null)).toBeNull();
	});
});

describe('pullDetails', () => {
	it('uses the merge commit only when GitHub says the PR is mergeable', async () => {
		route(detailsRoutes(pull()));
		expect((await pullDetails('t', ref)).mergeSha).toBe('merge1');
		route(detailsRoutes(pull({ mergeable: false })));
		expect((await pullDetails('t', ref)).mergeSha).toBeNull();
		route(detailsRoutes(pull({ mergeable: null })));
		expect((await pullDetails('t', ref)).mergeSha).toBeNull();
	});

	it('drops empty comments and tolerates deleted users', async () => {
		route(detailsRoutes(pull({ user: null })));
		const details = await pullDetails('t', ref);
		expect(details.author).toBe('unknown');
		expect(details.comments).toEqual([{ author: 'a', body: 'hi' }]);
	});
});

describe('pullDiff', () => {
	it('returns the full diff when available', async () => {
		route(() => new Response('diff --git a/x b/x', { status: 200 }));
		expect(await pullDiff('t', ref)).toEqual({ patch: 'diff --git a/x b/x', partial: false });
	});

	it('marks the file fallback partial when GitHub refuses the diff', async () => {
		route((url) =>
			url.includes('/files')
				? ok([{ filename: 'x.ts', patch: '@@ -1 +1 @@' }, { filename: 'big.bin' }])
				: new Response('too large', { status: 406 })
		);
		const diff = await pullDiff('t', ref);
		expect(diff.partial).toBe(true);
		expect(diff.patch).toContain('+++ b/x.ts');
		expect(diff.patch).toContain('(patch omitted by GitHub)');
	});

	it('throws on other errors rather than returning an empty diff', async () => {
		route(() => new Response('nope', { status: 500 }));
		await expect(pullDiff('t', ref)).rejects.toThrow('GitHub 500');
	});
});

describe('postPullReview', () => {
	it('always sends a comment-only event pinned to the commit', async () => {
		let sent: Record<string, unknown> = {};
		route((_, init) => {
			sent = JSON.parse(String(init.body));
			return ok({ html_url: 'https://github.com/r' });
		});
		const out = await postPullReview('t', ref, { commitSha: 'head1', body: 'b', comments: [] });
		expect(out.url).toBe('https://github.com/r');
		expect(sent.event).toBe('COMMENT');
		expect(sent.commit_id).toBe('head1');
	});
});

describe('commentableLines', () => {
	it('tracks new-side lines and skips removals', () => {
		const patch = [
			'diff --git a/x.ts b/x.ts',
			'--- a/x.ts',
			'+++ b/x.ts',
			'@@ -10,3 +20,3 @@ fn',
			' same',
			'-gone',
			'+added',
			' same',
			'diff --git a/y.ts b/y.ts',
			'--- a/y.ts',
			'+++ /dev/null',
			'@@ -1 +0,0 @@',
			'-deleted'
		].join('\n');
		const lines = commentableLines(patch);
		expect([...lines.get('x.ts')!]).toEqual([20, 21, 22]);
		expect(lines.has('y.ts')).toBe(false);
	});
});
