import type { ExternalItem, ItemOutcome, Provider } from './types';
import { ProviderAuthError } from './types';

const SEARCH_FIELDS = `
	nodes {
		... on PullRequest {
			id number title url state isDraft createdAt updatedAt
			repository { nameWithOwner }
			author { login avatarUrl }
			reviewDecision
			commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
		}
		... on Issue {
			id number title url state createdAt updatedAt
			repository { nameWithOwner }
			author { login avatarUrl }
			labels(first: 5) { nodes { name color } }
		}
	}`;

const PREVIEW = `query($id: ID!) {
	node(id: $id) {
		... on PullRequest { bodyHTML }
		... on Issue { bodyHTML }
	}
}`;

const outcomesQuery = (
	withReviews: boolean
) => `query($ids: [ID!]!${withReviews ? ', $login: String!' : ''}) {
	nodes(ids: $ids) {
		... on PullRequest {
			id state mergedAt closedAt
			${withReviews ? 'viewerReviews: reviews(last: 1, author: $login, states: [APPROVED, CHANGES_REQUESTED, COMMENTED]) { nodes { url state submittedAt } }' : ''}
		}
		... on Issue { id state closedAt stateReason }
	}
}`;

export interface GithubOutcomeNode {
	id: string;
	state?: string;
	mergedAt?: string | null;
	closedAt?: string | null;
	stateReason?: string | null;
	viewerReviews?: { nodes: ({ url: string; state: string; submittedAt: string | null } | null)[] };
}

/** MERGED / CLOSED / OPEN (PR) and CLOSED+reason / OPEN (issue) → an outcome. */
export function githubOutcome(n: GithubOutcomeNode): ItemOutcome | null {
	const base = githubState(n);
	if (!base) return null;
	const r = n.viewerReviews?.nodes.at(-1);
	return r?.submittedAt
		? { ...base, viewerReview: { url: r.url, state: r.state, at: r.submittedAt } }
		: base;
}

function githubState(n: GithubOutcomeNode): ItemOutcome | null {
	if (n.state === 'MERGED') return { outcome: 'merged', at: n.mergedAt ?? null };
	if (n.state === 'OPEN') return { outcome: 'open', at: null };
	if (n.state === 'CLOSED') {
		if (n.stateReason === 'COMPLETED') return { outcome: 'completed', at: n.closedAt ?? null };
		return { outcome: 'closed', at: n.closedAt ?? null };
	}
	return null;
}

const QUERY = `query {
	viewer { login }
	reviews: search(type: ISSUE, first: 50, query: "is:open is:pr review-requested:@me archived:false") { ${SEARCH_FIELDS} }
	mine: search(type: ISSUE, first: 50, query: "is:open is:pr author:@me archived:false") { ${SEARCH_FIELDS} }
	issues: search(type: ISSUE, first: 50, query: "is:open is:issue assignee:@me archived:false") { ${SEARCH_FIELDS} }
}`;

interface Node {
	id: string;
	number: number;
	title: string;
	url: string;
	state: string;
	isDraft?: boolean;
	createdAt?: string;
	updatedAt: string;
	repository: { nameWithOwner: string };
	author?: { login: string; avatarUrl: string } | null;
	reviewDecision?: string | null;
	commits?: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
	labels?: { nodes: { name: string; color: string }[] };
}

async function gql<T>(
	token: string,
	query: string,
	variables?: Record<string, unknown>
): Promise<T> {
	const res = await fetch('https://api.github.com/graphql', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			'User-Agent': 'corpus-app'
		},
		body: JSON.stringify({ query, variables })
	});
	if (res.status === 401) throw new ProviderAuthError('GitHub token rejected');
	if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
	const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
	if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
	return body.data as T;
}

function toItem(n: Node, kind: ExternalItem['kind']): ExternalItem {
	const checks = n.commits?.nodes[0]?.commit.statusCheckRollup?.state ?? null;
	const state =
		kind === 'pull_request'
			? [n.isDraft ? 'draft' : null, n.reviewDecision?.toLowerCase(), checks?.toLowerCase()]
					.filter(Boolean)
					.join(' · ') || 'open'
			: n.state.toLowerCase();
	return {
		externalId: `${kind}:${n.id}`,
		kind,
		title: n.title,
		subtitle: `${n.repository.nameWithOwner}#${n.number}`,
		url: n.url,
		state,
		externalUpdatedAt: n.updatedAt,
		payload: {
			createdAt: n.createdAt ?? null,
			author: n.author?.login,
			authorAvatar: n.author?.avatarUrl,
			checks,
			reviewDecision: n.reviewDecision ?? null,
			labels: n.labels?.nodes ?? []
		}
	};
}

export interface PullHead {
	/** OPEN | CLOSED | MERGED */
	state: string;
	headSha: string;
}

/** Current state and head commit for PR node ids, in one call. Unknown or inaccessible ids are left out. */
export async function pullHeads(
	token: string,
	nodeIds: string[]
): Promise<Record<string, PullHead>> {
	const out: Record<string, PullHead> = {};
	for (let i = 0; i < nodeIds.length; i += 100) {
		const data = await gql<{
			nodes: ({ id?: string; state?: string; headRefOid?: string } | null)[];
		}>(
			token,
			'query($ids: [ID!]!) { nodes(ids: $ids) { ... on PullRequest { id state headRefOid } } }',
			{
				ids: nodeIds.slice(i, i + 100)
			}
		);
		for (const n of data.nodes)
			if (n?.id && n.state && n.headRefOid) out[n.id] = { state: n.state, headSha: n.headRefOid };
	}
	return out;
}

export const github: Provider = {
	id: 'github',
	name: 'GitHub',
	appSetupUrl: 'https://github.com/settings/applications/new',
	personalToken: {
		label: 'Personal access token',
		createUrl: 'https://github.com/settings/tokens/new?description=Corpus&scopes=repo,read:user',
		hint: 'Classic token with the repo and read:user scopes.'
	},
	authorizeUrl(cfg, state) {
		const u = new URL('https://github.com/login/oauth/authorize');
		u.searchParams.set('client_id', cfg.clientId);
		u.searchParams.set('redirect_uri', cfg.redirectUri);
		u.searchParams.set('scope', 'repo read:user');
		u.searchParams.set('state', state);
		return u.toString();
	},
	async exchangeCode(cfg, code) {
		const res = await fetch('https://github.com/login/oauth/access_token', {
			method: 'POST',
			headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
			body: JSON.stringify({
				client_id: cfg.clientId,
				client_secret: cfg.clientSecret,
				code,
				redirect_uri: cfg.redirectUri
			})
		});
		const body = (await res.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
			scope?: string;
			error_description?: string;
		};
		if (!body.access_token) throw new Error(body.error_description ?? 'GitHub OAuth failed');
		return {
			accessToken: body.access_token,
			refreshToken: body.refresh_token ?? null,
			expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
			scopes: body.scope ?? null
		};
	},
	async refresh(cfg, refreshToken) {
		const res = await fetch('https://github.com/login/oauth/access_token', {
			method: 'POST',
			headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
			body: JSON.stringify({
				client_id: cfg.clientId,
				client_secret: cfg.clientSecret,
				grant_type: 'refresh_token',
				refresh_token: refreshToken
			})
		});
		const body = (await res.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
		};
		if (!body.access_token) throw new ProviderAuthError('GitHub refresh failed');
		return {
			accessToken: body.access_token,
			refreshToken: body.refresh_token ?? refreshToken,
			expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null
		};
	},
	async account(token) {
		const data = await gql<{ viewer: { login: string; avatarUrl: string } }>(
			token,
			'query { viewer { login avatarUrl } }'
		);
		return { login: data.viewer.login, avatarUrl: data.viewer.avatarUrl };
	},
	async poll(token, cursor) {
		const data = await gql<{
			reviews: { nodes: Node[] };
			mine: { nodes: Node[] };
			issues: { nodes: Node[] };
		}>(token, QUERY);
		const items = [
			...data.reviews.nodes.filter((n) => n.id).map((n) => toItem(n, 'review_request')),
			...data.mine.nodes.filter((n) => n.id).map((n) => toItem(n, 'pull_request')),
			...data.issues.nodes.filter((n) => n.id).map((n) => toItem(n, 'issue'))
		];
		return {
			items,
			cursor: { ...cursor, polledAt: new Date().toISOString() },
			pollIntervalSec: 60
		};
	},
	async preview(token, externalId) {
		const id = externalId.slice(externalId.indexOf(':') + 1);
		const data = await gql<{ node: { bodyHTML?: string } | null }>(token, PREVIEW, { id });
		return { format: 'html', body: data.node?.bodyHTML?.trim() || null };
	},
	async outcomes(token, externalIds, context) {
		// No login → no review lookup: an unfiltered query would match anyone's review.
		const login = context?.login ?? null;
		const byNode = new Map(externalIds.map((e) => [e.slice(e.indexOf(':') + 1), e]));
		const out: Record<string, ItemOutcome> = {};
		const ids = [...byNode.keys()];
		for (let i = 0; i < ids.length; i += 100) {
			const data = await gql<{ nodes: (GithubOutcomeNode | null)[] }>(
				token,
				outcomesQuery(!!login),
				login ? { ids: ids.slice(i, i + 100), login } : { ids: ids.slice(i, i + 100) }
			);
			for (const n of data.nodes) {
				const o = n?.id ? githubOutcome(n) : null;
				const ext = n?.id ? byNode.get(n.id) : undefined;
				if (o && ext) out[ext] = o;
			}
		}
		return out;
	}
};
