import type { ExternalItem, Provider, TokenSet } from './types';
import { ProviderAuthError } from './types';

const QUERY = `query {
	viewer {
		assignedIssues(first: 100, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
			nodes {
				id identifier title url priority priorityLabel dueDate updatedAt
				state { name type color }
				team { key name }
				project { name }
			}
		}
	}
}`;

const PREVIEW = `query($id: String!) { issue(id: $id) { description } }`;

interface Issue {
	id: string;
	identifier: string;
	title: string;
	url: string;
	priority: number;
	priorityLabel: string;
	dueDate: string | null;
	updatedAt: string;
	state: { name: string; type: string; color: string };
	team: { key: string; name: string };
	project: { name: string } | null;
}

async function gql<T>(
	token: string,
	query: string,
	variables?: Record<string, unknown>
): Promise<T> {
	const res = await fetch('https://api.linear.app/graphql', {
		method: 'POST',
		headers: {
			// Personal API keys are sent bare; OAuth access tokens use Bearer.
			Authorization: token.startsWith('lin_api_') ? token : `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ query, variables })
	});
	if (res.status === 401) throw new ProviderAuthError('Linear token rejected');
	const body = (await res.json()) as {
		data?: T;
		errors?: { message: string; extensions?: { code?: string } }[];
	};
	if (body.errors?.some((e) => e.extensions?.code === 'AUTHENTICATION_ERROR'))
		throw new ProviderAuthError('Linear token rejected');
	if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
	if (!res.ok) throw new Error(`Linear ${res.status}`);
	return body.data as T;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenSet> {
	const res = await fetch('https://api.linear.app/oauth/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(params)
	});
	const body = (await res.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
		scope?: string | string[];
		error_description?: string;
	};
	if (!body.access_token)
		throw new ProviderAuthError(body.error_description ?? 'Linear OAuth failed');
	return {
		accessToken: body.access_token,
		refreshToken: body.refresh_token ?? null,
		expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
		scopes: Array.isArray(body.scope) ? body.scope.join(',') : (body.scope ?? null)
	};
}

export const linear: Provider = {
	id: 'linear',
	name: 'Linear',
	appSetupUrl: 'https://linear.app/settings/api/applications/new',
	personalToken: {
		label: 'Personal API key',
		createUrl: 'https://linear.app/settings/account/security',
		hint: 'Settings → Security & access → Personal API keys → New key (read access is enough).'
	},
	authorizeUrl(cfg, state) {
		const u = new URL('https://linear.app/oauth/authorize');
		u.searchParams.set('client_id', cfg.clientId);
		u.searchParams.set('redirect_uri', cfg.redirectUri);
		u.searchParams.set('response_type', 'code');
		u.searchParams.set('scope', 'read');
		u.searchParams.set('state', state);
		u.searchParams.set('prompt', 'consent');
		return u.toString();
	},
	exchangeCode(cfg, code) {
		return tokenRequest({
			grant_type: 'authorization_code',
			code,
			redirect_uri: cfg.redirectUri,
			client_id: cfg.clientId,
			client_secret: cfg.clientSecret
		});
	},
	refresh(cfg, refreshToken) {
		return tokenRequest({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
			client_id: cfg.clientId,
			client_secret: cfg.clientSecret
		});
	},
	async account(token) {
		const data = await gql<{ viewer: { name: string; email: string; avatarUrl: string | null } }>(
			token,
			'query { viewer { name email avatarUrl } }'
		);
		return { login: data.viewer.email || data.viewer.name, avatarUrl: data.viewer.avatarUrl };
	},
	async poll(token, cursor) {
		const data = await gql<{ viewer: { assignedIssues: { nodes: Issue[] } } }>(token, QUERY);
		const items: ExternalItem[] = data.viewer.assignedIssues.nodes.map((i) => ({
			externalId: `issue:${i.id}`,
			kind: 'issue',
			title: i.title,
			subtitle: `${i.identifier} · ${i.team.name}${i.project ? ` · ${i.project.name}` : ''}`,
			url: i.url,
			state: i.state.name,
			externalUpdatedAt: i.updatedAt,
			dueDate: i.dueDate,
			payload: {
				identifier: i.identifier,
				priority: i.priority,
				priorityLabel: i.priorityLabel,
				stateType: i.state.type,
				stateColor: i.state.color
			}
		}));
		return {
			items,
			cursor: { ...cursor, polledAt: new Date().toISOString() },
			pollIntervalSec: 60
		};
	},
	async preview(token, externalId) {
		const id = externalId.slice(externalId.indexOf(':') + 1);
		const data = await gql<{ issue: { description: string | null } }>(token, PREVIEW, { id });
		return { format: 'markdown', body: data.issue.description?.trim() || null };
	}
};
