import type { Provider, TokenSet } from './types';
import { ProviderAuthError } from './types';

/** User-token scopes: read threads/mentions everywhere the user can, reply as the user. */
const USER_SCOPES = [
	'search:read',
	'channels:history',
	'groups:history',
	'im:history',
	'mpim:history',
	'channels:read',
	'groups:read',
	'im:read',
	'mpim:read',
	'users:read',
	'chat:write'
];

const AUTH_ERRORS = new Set([
	'invalid_auth',
	'not_authed',
	'token_revoked',
	'token_expired',
	'account_inactive',
	'missing_scope'
]);

export class SlackApiError extends Error {
	constructor(
		public code: string,
		public retryAfterSec?: number
	) {
		super(`Slack: ${code}`);
	}
}

async function call<T>(
	token: string,
	method: string,
	params: Record<string, string | undefined> = {}
) {
	const body = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, v);
	const res = await fetch(`https://slack.com/api/${method}`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body
	});
	if (res.status === 429)
		throw new SlackApiError('ratelimited', Number(res.headers.get('retry-after') ?? 60));
	const json = (await res.json()) as T & { ok: boolean; error?: string };
	if (!json.ok) {
		const code = json.error ?? 'unknown_error';
		if (AUTH_ERRORS.has(code)) throw new ProviderAuthError(`Slack: ${code}`);
		throw new SlackApiError(code);
	}
	return json;
}

export interface SlackMessage {
	ts: string;
	thread_ts?: string;
	user?: string;
	bot_id?: string;
	username?: string;
	text: string;
	reply_count?: number;
	latest_reply?: string;
	subtype?: string;
	files?: { name?: string; permalink?: string }[];
	edited?: { ts: string };
}

export interface SlackSearchMatch {
	ts: string;
	text: string;
	user?: string;
	username?: string;
	permalink: string;
	channel: { id: string; name?: string; is_im?: boolean; is_mpim?: boolean };
}

export interface SlackUser {
	id: string;
	name: string;
	image: string | null;
}

const userCache = new Map<string, { user: SlackUser; at: number }>();

/** Thin Slack Web API client (user token). */
export const slackApi = {
	authTest(token: string) {
		return call<{ user_id: string; user: string; team: string; team_id: string; url: string }>(
			token,
			'auth.test'
		);
	},

	/** Recent messages that @mention the user, newest first. */
	async mentions(token: string, userId: string, count = 30): Promise<SlackSearchMatch[]> {
		const res = await call<{ messages: { matches: SlackSearchMatch[] } }>(
			token,
			'search.messages',
			{
				query: `<@${userId}>`,
				sort: 'timestamp',
				sort_dir: 'desc',
				count: String(count)
			}
		);
		return res.messages.matches ?? [];
	},

	/** Messages in a thread (root first). `oldest` is exclusive. */
	async replies(token: string, channel: string, ts: string, oldest?: string) {
		const out: SlackMessage[] = [];
		let cursor: string | undefined;
		do {
			const res = await call<{
				messages: SlackMessage[];
				response_metadata?: { next_cursor?: string };
			}>(token, 'conversations.replies', {
				channel,
				ts,
				oldest,
				inclusive: oldest ? 'false' : 'true',
				limit: '200',
				cursor
			});
			out.push(...res.messages);
			cursor = res.response_metadata?.next_cursor || undefined;
		} while (cursor && out.length < 1000);
		// When `oldest` is set Slack still returns the root; drop it if it's not newer.
		return oldest ? out.filter((m) => Number(m.ts) > Number(oldest)) : out;
	},

	post(token: string, channel: string, threadTs: string, text: string) {
		return call<{ ts: string }>(token, 'chat.postMessage', { channel, thread_ts: threadTs, text });
	},

	async permalink(token: string, channel: string, ts: string) {
		const res = await call<{ permalink: string }>(token, 'chat.getPermalink', {
			channel,
			message_ts: ts
		});
		return res.permalink;
	},

	/** Display name for a conversation: #channel, or the DM partner's name. */
	async channelName(token: string, channel: string): Promise<string> {
		const res = await call<{
			channel: { name?: string; is_im?: boolean; is_mpim?: boolean; user?: string };
		}>(token, 'conversations.info', { channel });
		const c = res.channel;
		if (c.is_im && c.user) return (await slackApi.user(token, c.user)).name;
		if (c.is_mpim) return 'Group DM';
		return `#${c.name ?? channel}`;
	},

	async user(token: string, id: string): Promise<SlackUser> {
		const hit = userCache.get(id);
		if (hit && Date.now() - hit.at < 3_600_000) return hit.user;
		try {
			const res = await call<{
				user: {
					id: string;
					name: string;
					real_name?: string;
					profile?: { display_name?: string; real_name?: string; image_48?: string };
				};
			}>(token, 'users.info', { user: id });
			const u = res.user;
			const user = {
				id: u.id,
				name: u.profile?.display_name || u.profile?.real_name || u.real_name || u.name,
				image: u.profile?.image_48 ?? null
			};
			userCache.set(id, { user, at: Date.now() });
			return user;
		} catch (e) {
			if (e instanceof ProviderAuthError) throw e;
			return { id, name: id, image: null };
		}
	},

	/** Resolve every user id referenced by messages (authors + <@mentions>). */
	async users(token: string, messages: { user?: string; text: string }[]) {
		const ids = new Set<string>();
		for (const m of messages) {
			if (m.user) ids.add(m.user);
			for (const x of m.text.matchAll(/<@([UW][A-Z0-9]+)/g)) ids.add(x[1]!);
		}
		const list = await Promise.all([...ids].map((id) => slackApi.user(token, id)));
		return Object.fromEntries(list.map((u) => [u.id, u]));
	}
};

/** `https://x.slack.com/archives/C123/p1700000000123456?thread_ts=…` → thread coordinates. */
export function parseSlackLink(
	link: string
): { channel: string; ts: string; threadTs: string } | null {
	let url: URL;
	try {
		url = new URL(link.trim());
	} catch {
		return null;
	}
	const m = url.pathname.match(/\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/);
	if (!m) return null;
	const ts = `${m[2]}.${m[3]}`;
	return { channel: m[1]!, ts, threadTs: url.searchParams.get('thread_ts') ?? ts };
}

export type SlackSegment =
	| { t: 'text' | 'bold' | 'italic' | 'strike' | 'code' | 'pre'; v: string }
	| { t: 'link'; href: string; v: string }
	| { t: 'user'; id: string; v: string }
	| { t: 'channel'; id: string; v: string };

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function inline(text: string, out: SlackSegment[]) {
	const re = /`([^`\n]+)`|\*([^*\n]+)\*|(?<![\w])_([^_\n]+)_(?![\w])|~([^~\n]+)~/g;
	let last = 0;
	for (const m of text.matchAll(re)) {
		if (m.index! > last) out.push({ t: 'text', v: decode(text.slice(last, m.index)) });
		if (m[1] !== undefined) out.push({ t: 'code', v: decode(m[1]) });
		else if (m[2] !== undefined) out.push({ t: 'bold', v: decode(m[2]) });
		else if (m[3] !== undefined) out.push({ t: 'italic', v: decode(m[3]) });
		else out.push({ t: 'strike', v: decode(m[4]!) });
		last = m.index! + m[0].length;
	}
	if (last < text.length) out.push({ t: 'text', v: decode(text.slice(last)) });
}

/**
 * Tokenize Slack mrkdwn into renderable segments (no HTML, so it's safe to render as text).
 * `names` maps user ids to display names.
 */
export function parseMrkdwn(text: string, names: Record<string, string> = {}): SlackSegment[] {
	const out: SlackSegment[] = [];
	const re = /```([\s\S]*?)```|<([^>\n]+)>/g;
	let last = 0;
	for (const m of text.matchAll(re)) {
		if (m.index! > last) inline(text.slice(last, m.index), out);
		last = m.index! + m[0].length;
		if (m[1] !== undefined) {
			out.push({ t: 'pre', v: decode(m[1].replace(/^\n/, '')) });
			continue;
		}
		const [target, label] = m[2]!.split('|', 2) as [string, string | undefined];
		if (target.startsWith('@')) {
			const id = target.slice(1);
			out.push({ t: 'user', id, v: `@${label ?? names[id] ?? id}` });
		} else if (target.startsWith('#')) {
			out.push({ t: 'channel', id: target.slice(1), v: `#${label ?? target.slice(1)}` });
		} else if (target.startsWith('!')) {
			const word = label ?? target.slice(1).split('^')[0]!;
			out.push({ t: 'text', v: word.startsWith('@') ? word : `@${word}` });
		} else {
			const href = decode(target);
			const safe = /^(https?|mailto):/i.test(href);
			out.push(
				safe
					? { t: 'link', href, v: decode(label ?? href.replace(/^mailto:/, '')) }
					: { t: 'text', v: decode(label ?? href) }
			);
		}
	}
	if (last < text.length) inline(text.slice(last), out);
	return out;
}

/** Plain-text rendering of mrkdwn (notification bodies, previews). */
export function mrkdwnToText(text: string, names: Record<string, string> = {}) {
	return parseMrkdwn(text, names)
		.map((s) => s.v)
		.join('')
		.replace(/\s+/g, ' ')
		.trim();
}

// ---------------------------------------------------------------------------
// OAuth provider (user token)
// ---------------------------------------------------------------------------

async function tokenRequest(params: Record<string, string>): Promise<TokenSet> {
	const res = await fetch('https://slack.com/api/oauth.v2.access', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(params)
	});
	const body = (await res.json()) as {
		ok: boolean;
		error?: string;
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
		scope?: string;
		authed_user?: {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
			scope?: string;
		};
	};
	// Install returns the user token under authed_user; rotation refreshes return it top-level.
	const t = body.authed_user?.access_token ? body.authed_user : body;
	if (!body.ok || !t.access_token)
		throw new ProviderAuthError(`Slack: ${body.error ?? 'OAuth failed'}`);
	return {
		accessToken: t.access_token,
		refreshToken: t.refresh_token ?? null,
		expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null,
		scopes: t.scope ?? null
	};
}

export const slack: Provider = {
	id: 'slack',
	name: 'Slack',
	appSetupUrl: 'https://api.slack.com/apps?new_app=1',
	envPrefix: 'SLACK',
	authorizeUrl(cfg, state) {
		const u = new URL('https://slack.com/oauth/v2/authorize');
		u.searchParams.set('client_id', cfg.clientId);
		u.searchParams.set('user_scope', USER_SCOPES.join(','));
		u.searchParams.set('redirect_uri', cfg.redirectUri);
		u.searchParams.set('state', state);
		return u.toString();
	},
	exchangeCode(cfg, code) {
		return tokenRequest({
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
		const me = await slackApi.authTest(token);
		const profile = await slackApi.user(token, me.user_id);
		return { login: `${profile.name} · ${me.team}`, avatarUrl: profile.image };
	}
};
