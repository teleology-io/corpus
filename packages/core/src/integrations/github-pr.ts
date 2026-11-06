// REST reads and the one write that Integration Review needs for a single pull request.
import { ProviderAuthError } from './types';

const API = 'https://api.github.com';
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

export interface PullRef {
	owner: string;
	repo: string;
	number: number;
}

export interface PullComment {
	author: string;
	body: string;
	path?: string;
	line?: number | null;
}

export interface PullDetails {
	title: string;
	body: string;
	author: string;
	draft: boolean;
	state: string;
	headSha: string;
	baseSha: string;
	baseRef: string;
	/** GitHub's test merge with the current base. Null while computing or when conflicted. */
	mergeSha: string | null;
	mergeable: boolean | null;
	commits: { sha: string; message: string }[];
	comments: PullComment[];
	checks: { name: string; status: string; conclusion: string | null }[];
}

export interface PullDiff {
	patch: string;
	/** True when GitHub wouldn't produce the full diff, so some of the change is missing. */
	partial: boolean;
}

export interface ReviewComment {
	path: string;
	line: number;
	body: string;
}

/** The `owner/repo#123` subtitle that poll() stores on integration items. */
export function parsePullRef(subtitle: string | null | undefined): PullRef | null {
	const match = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(subtitle ?? '');
	return match ? { owner: match[1]!, repo: match[2]!, number: Number(match[3]) } : null;
}

async function request(token: string, path: string, init: RequestInit = {}, accept?: string) {
	const res = await fetch(`${API}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: accept ?? 'application/vnd.github+json',
			'User-Agent': 'corpus-app',
			'X-GitHub-Api-Version': '2022-11-28',
			...(init.body ? { 'Content-Type': 'application/json' } : {})
		}
	});
	if (res.status === 401) throw new ProviderAuthError('GitHub token rejected');
	return res;
}

async function json<T>(token: string, path: string): Promise<T> {
	const res = await request(token, path);
	if (!res.ok) throw new Error(`GitHub ${res.status} on ${path}: ${await res.text()}`);
	return (await res.json()) as T;
}

/** Up to MAX_PAGES of a list. The second value reports whether more remained. */
async function list<T>(token: string, path: string): Promise<[T[], boolean]> {
	const out: T[] = [];
	const join = path.includes('?') ? '&' : '?';
	for (let page = 1; page <= MAX_PAGES; page++) {
		const batch = await json<T[]>(token, `${path}${join}per_page=${PAGE_SIZE}&page=${page}`);
		out.push(...batch);
		if (batch.length < PAGE_SIZE) return [out, false];
	}
	return [out, true];
}

const base = ({ owner, repo }: PullRef) =>
	`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

export async function pullDetails(token: string, ref: PullRef): Promise<PullDetails> {
	const pull = `${base(ref)}/pulls/${ref.number}`;
	const pr = await json<{
		title: string;
		body: string | null;
		state: string;
		draft?: boolean;
		user: { login: string } | null;
		head: { sha: string };
		base: { sha: string; ref: string };
		merge_commit_sha: string | null;
		mergeable: boolean | null;
	}>(token, pull);
	type Raw = {
		user: { login: string } | null;
		body: string | null;
		path?: string;
		line?: number | null;
	};
	const [[commits], [threads], [issue], [reviews], checks] = await Promise.all([
		list<{ sha: string; commit: { message: string } }>(token, `${pull}/commits`),
		list<Raw>(token, `${pull}/comments`),
		list<Raw>(token, `${base(ref)}/issues/${ref.number}/comments`),
		list<Raw>(token, `${pull}/reviews`),
		json<{ check_runs: { name: string; status: string; conclusion: string | null }[] }>(
			token,
			`${base(ref)}/commits/${pr.head.sha}/check-runs?per_page=${PAGE_SIZE}`
		)
	]);
	const comment = (c: Raw): PullComment => ({
		author: c.user?.login ?? 'unknown',
		body: c.body ?? '',
		path: c.path,
		line: c.line
	});
	return {
		title: pr.title,
		body: pr.body ?? '',
		author: pr.user?.login ?? 'unknown',
		draft: pr.draft === true,
		state: pr.state,
		headSha: pr.head.sha,
		baseSha: pr.base.sha,
		baseRef: pr.base.ref,
		// merge_commit_sha can linger from an earlier test merge, so only trust it when mergeable.
		mergeSha: pr.mergeable === true ? pr.merge_commit_sha : null,
		mergeable: pr.mergeable,
		commits: commits.map((c) => ({ sha: c.sha, message: c.commit.message })),
		comments: [...issue, ...reviews, ...threads].map(comment).filter((c) => c.body.trim()),
		checks: checks.check_runs.map((c) => ({
			name: c.name,
			status: c.status,
			conclusion: c.conclusion
		}))
	};
}

/**
 * The full diff when GitHub will produce one. Oversized PRs fall back to per-file patches, which
 * GitHub truncates, so that result is always marked partial.
 */
export async function pullDiff(token: string, ref: PullRef): Promise<PullDiff> {
	const pull = `${base(ref)}/pulls/${ref.number}`;
	const res = await request(token, pull, {}, 'application/vnd.github.diff');
	if (res.ok) return { patch: await res.text(), partial: false };
	if (res.status !== 406 && res.status !== 422)
		throw new Error(`GitHub ${res.status} on ${pull}: ${await res.text()}`);
	const [files] = await list<{ filename: string; patch?: string }>(token, `${pull}/files`);
	const patch = files
		.map(
			(f) => `--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch ?? '(patch omitted by GitHub)'}`
		)
		.join('\n');
	return { patch, partial: true };
}

/** The repository at one commit, as a tar.gz stream. Merge and fork commits resolve through the base repo. */
export async function pullTarball(token: string, ref: PullRef, sha: string) {
	const path = `${base(ref)}/tarball/${encodeURIComponent(sha)}`;
	const res = await request(token, path);
	if (!res.ok || !res.body) throw new Error(`GitHub ${res.status} on ${path}`);
	return res.body;
}

/** Posts as the connected user. Comment-only by construction: it can't approve or block a PR. */
export async function postPullReview(
	token: string,
	ref: PullRef,
	review: { commitSha: string; body: string; comments: ReviewComment[] }
): Promise<{ url: string }> {
	const path = `${base(ref)}/pulls/${ref.number}/reviews`;
	const res = await request(token, path, {
		method: 'POST',
		body: JSON.stringify({
			commit_id: review.commitSha,
			event: 'COMMENT',
			body: review.body,
			comments: review.comments.map((c) => ({
				path: c.path,
				line: c.line,
				side: 'RIGHT',
				body: c.body
			}))
		})
	});
	if (!res.ok) throw new Error(`GitHub ${res.status} on ${path}: ${await res.text()}`);
	return { url: ((await res.json()) as { html_url: string }).html_url };
}

/** Lines a review comment can anchor to: added or context lines on the new side, by file. */
export function commentableLines(patch: string): Map<string, Set<number>> {
	const out = new Map<string, Set<number>>();
	let lines: Set<number> | null = null;
	let next = 0;
	for (const row of patch.split('\n')) {
		if (row.startsWith('diff --git ')) {
			lines = null;
			continue;
		}
		const file = /^\+\+\+ b\/(.+)$/.exec(row);
		if (file) {
			lines = new Set();
			out.set(file[1]!, lines);
			continue;
		}
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
		if (hunk) {
			next = Number(hunk[1]);
			continue;
		}
		if (!lines || !next) continue;
		if (row.startsWith('+') || row.startsWith(' ')) lines.add(next++);
	}
	return out;
}
