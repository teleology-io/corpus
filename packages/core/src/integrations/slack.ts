import type { Provider, TokenSet } from './types';
import { ProviderAuthError } from './types';

/** User-token scopes: read conversations/threads/search everywhere the user can, post as the user. */
export const SLACK_USER_SCOPES = [
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

/** Token problems that need the user to reconnect. `missing_scope` is per feature, not fatal. */
const AUTH_ERRORS = new Set([
	'invalid_auth',
	'not_authed',
	'token_revoked',
	'token_expired',
	'account_inactive',
	'not_allowed_token_type'
]);

/** Slack error codes → message safe to show (never includes tokens or headers). */
export const SLACK_ERROR_MESSAGES: Record<string, string> = {
	invalid_auth: 'Slack rejected the token — reconnect Slack',
	not_authed: 'No Slack token was sent — reconnect Slack',
	token_revoked: 'The Slack token was revoked — reconnect Slack',
	token_expired: 'The Slack token expired — reconnect Slack',
	account_inactive: 'That Slack account is deactivated',
	not_allowed_token_type: 'Corpus needs a Slack user token (xoxp-…)',
	missing_scope: 'The Slack token is missing a scope this needs',
	channel_not_found: 'You don’t have access to that conversation',
	not_in_channel: 'Join the channel in Slack to post there',
	thread_not_found: 'That thread no longer exists',
	is_archived: 'That channel is archived',
	ratelimited: 'Slack is rate limiting requests — try again shortly',
	rate_limited: 'Slack is rate limiting requests — try again shortly',
	restricted_action: 'Your workspace doesn’t allow that action',
	msg_too_long: 'That message is too long for Slack',
	no_text: 'Write something first'
};

export class SlackApiError extends Error {
	constructor(
		public code: string,
		public retryAfterSec?: number,
		/** For missing_scope: the scope Slack says is needed. */
		public needed?: string
	) {
		super(`Slack: ${code}${needed ? ` (needs ${needed})` : ''}`);
	}
}

export type SlackPriority = 'interactive' | 'background';

/** Hooks a caller can plug in (rate limiting is shared across processes via the database). */
export interface SlackHooks {
	/** Awaited before every call; throw `SlackApiError('ratelimited', sec)` to refuse. */
	acquire?(method: string, priority: SlackPriority): Promise<void>;
	/** Called when Slack answers 429 / `ratelimited`. */
	onRateLimited?(method: string, retryAfterSec: number): Promise<void> | void;
	priority?: SlackPriority;
	/** Test seams. */
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
}

/** Methods that change state — never retried automatically (a retry could post twice). */
const WRITES = new Set(['chat.postMessage']);
const RETRIES = 3;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface SlackFile {
	id?: string;
	name?: string;
	title?: string;
	mimetype?: string;
	size?: number;
	permalink?: string;
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
	files?: SlackFile[];
	edited?: { ts: string };
}

export interface SlackSearchMatch {
	ts: string;
	text: string;
	user?: string;
	username?: string;
	permalink: string;
	channel: { id: string; name?: string; is_im?: boolean; is_mpim?: boolean; is_private?: boolean };
}

export interface SlackSearchFile extends SlackFile {
	user?: string;
	timestamp?: number;
	channels?: string[];
	groups?: string[];
	ims?: string[];
}

export interface SlackConversation {
	id: string;
	name?: string;
	is_channel?: boolean;
	is_group?: boolean;
	is_im?: boolean;
	is_mpim?: boolean;
	is_private?: boolean;
	is_archived?: boolean;
	is_member?: boolean;
	user?: string;
	topic?: { value?: string };
	purpose?: { value?: string };
	num_members?: number;
	updated?: number;
	/** conversations.info, DMs only */
	latest?: { ts?: string; user?: string; text?: string; bot_id?: string; username?: string } | null;
	last_read?: string;
	unread_count_display?: number;
}

export type SlackConversationKind = 'public' | 'private' | 'im' | 'mpim';

export function conversationKind(c: SlackConversation): SlackConversationKind {
	if (c.is_im) return 'im';
	if (c.is_mpim) return 'mpim';
	return c.is_private || c.is_group ? 'private' : 'public';
}

export interface SlackUser {
	id: string;
	name: string;
	image: string | null;
}

export interface SlackIdentity {
	userId: string;
	user: string;
	teamId: string;
	team: string;
	url: string;
	/** Comma-separated granted scopes (from the x-oauth-scopes header), if reported. */
	scopes: string | null;
}

interface Page<T> {
	items: T[];
	nextCursor: string | null;
}

type Params = Record<string, string | number | boolean | undefined>;

const userCache = new Map<string, { user: SlackUser; at: number }>();
const USER_TTL = 3_600_000;

/** Thin Slack Web API client bound to one user token. Pure: no storage, no logging of secrets. */
export function createSlackClient(token: string, hooks: SlackHooks = {}) {
	const doFetch = hooks.fetch ?? fetch;
	const sleep = hooks.sleep ?? defaultSleep;
	const priority = hooks.priority ?? 'interactive';

	async function request<T>(method: string, params: Params = {}) {
		await hooks.acquire?.(method, priority);
		const write = WRITES.has(method);
		const clean: Record<string, string> = {};
		for (const [k, v] of Object.entries(params)) if (v !== undefined) clean[k] = String(v);
		const qs = new URLSearchParams(clean);
		let attempt = 0;
		for (;;) {
			let res: Response;
			try {
				res = write
					? await doFetch(`https://slack.com/api/${method}`, {
							method: 'POST',
							headers: {
								Authorization: `Bearer ${token}`,
								'Content-Type': 'application/x-www-form-urlencoded'
							},
							body: qs
						})
					: await doFetch(`https://slack.com/api/${method}${qs.size ? `?${qs}` : ''}`, {
							headers: { Authorization: `Bearer ${token}` }
						});
			} catch {
				if (write || attempt >= RETRIES) throw new SlackApiError('network_error');
				await sleep(backoff(attempt++));
				continue;
			}
			if (res.status === 429) {
				const sec = Math.max(1, Number(res.headers.get('retry-after')) || 60);
				await hooks.onRateLimited?.(method, sec);
				throw new SlackApiError('ratelimited', sec);
			}
			if (res.status >= 500) {
				if (write || attempt >= RETRIES) throw new SlackApiError(`http_${res.status}`);
				await sleep(backoff(attempt++));
				continue;
			}
			const json = (await res.json()) as T & { ok: boolean; error?: string; needed?: string };
			if (!json.ok) {
				const code = json.error ?? 'unknown_error';
				if (AUTH_ERRORS.has(code)) throw new ProviderAuthError(`Slack: ${code}`);
				if (code === 'ratelimited' || code === 'rate_limited') {
					const sec = Math.max(1, Number(res.headers.get('retry-after')) || 60);
					await hooks.onRateLimited?.(method, sec);
					throw new SlackApiError(code, sec);
				}
				throw new SlackApiError(code, undefined, json.needed);
			}
			return { json, headers: res.headers };
		}
	}

	const call = async <T>(method: string, params?: Params) =>
		(await request<T>(method, params)).json;

	const client = {
		async authTest(): Promise<SlackIdentity> {
			const { json, headers } = await request<{
				user_id: string;
				user: string;
				team: string;
				team_id: string;
				url: string;
				bot_id?: string;
			}>('auth.test');
			if (json.bot_id) throw new ProviderAuthError('Slack: not_allowed_token_type');
			return {
				userId: json.user_id,
				user: json.user,
				teamId: json.team_id,
				team: json.team,
				url: json.url,
				scopes: headers.get('x-oauth-scopes')
			};
		},

		/** Conversations the user is a member of (what Slack's sidebar shows). */
		async usersConversations(cursor?: string): Promise<Page<SlackConversation>> {
			const res = await call<{
				channels: SlackConversation[];
				response_metadata?: { next_cursor?: string };
			}>('users.conversations', {
				types: 'public_channel,private_channel,mpim,im',
				exclude_archived: true,
				limit: 200,
				cursor
			});
			return { items: res.channels, nextCursor: res.response_metadata?.next_cursor || null };
		},

		/** Every conversation visible to the user (browse channels to open). */
		async conversationsList(
			opts: { types?: string; cursor?: string; limit?: number } = {}
		): Promise<Page<SlackConversation>> {
			const res = await call<{
				channels: SlackConversation[];
				response_metadata?: { next_cursor?: string };
			}>('conversations.list', {
				types: opts.types ?? 'public_channel,private_channel',
				exclude_archived: true,
				limit: opts.limit ?? 200,
				cursor: opts.cursor
			});
			return { items: res.channels, nextCursor: res.response_metadata?.next_cursor || null };
		},

		async conversationInfo(channel: string) {
			return (await call<{ channel: SlackConversation }>('conversations.info', { channel }))
				.channel;
		},

		/** One page of channel history, newest first. `oldest`/`latest` are exclusive unless `inclusive`. */
		async history(
			channel: string,
			opts: {
				oldest?: string;
				latest?: string;
				cursor?: string;
				limit?: number;
				inclusive?: boolean;
			} = {}
		) {
			const res = await call<{
				messages: SlackMessage[];
				has_more?: boolean;
				response_metadata?: { next_cursor?: string };
			}>('conversations.history', {
				channel,
				oldest: opts.oldest,
				latest: opts.latest,
				inclusive: opts.inclusive,
				limit: opts.limit ?? 100,
				cursor: opts.cursor
			});
			return {
				messages: res.messages ?? [],
				hasMore: !!res.has_more,
				nextCursor: res.response_metadata?.next_cursor || null
			};
		},

		/** One page of a thread, root first. */
		async repliesPage(
			channel: string,
			ts: string,
			opts: { oldest?: string; cursor?: string; limit?: number } = {}
		) {
			const res = await call<{
				messages: SlackMessage[];
				has_more?: boolean;
				response_metadata?: { next_cursor?: string };
			}>('conversations.replies', {
				channel,
				ts,
				oldest: opts.oldest,
				inclusive: opts.oldest ? false : undefined,
				limit: opts.limit ?? 200,
				cursor: opts.cursor
			});
			return {
				messages: res.messages ?? [],
				nextCursor: res.response_metadata?.next_cursor || null
			};
		},

		/** Whole thread (root first, capped). `oldest` is exclusive and drops the root if not newer. */
		async replies(channel: string, ts: string, oldest?: string, limit = 200) {
			const out: SlackMessage[] = [];
			let cursor: string | undefined;
			do {
				const page = await client.repliesPage(channel, ts, { oldest, cursor, limit });
				out.push(...page.messages);
				cursor = page.nextCursor ?? undefined;
			} while (cursor && out.length < 1000);
			return oldest ? out.filter((m) => Number(m.ts) > Number(oldest)) : out;
		},

		/** Posts as the token's user. Only ever sent with a user token — no bot fallback. */
		async postMessage(channel: string, text: string, threadTs?: string) {
			const res = await call<{ channel: string; ts: string; message?: SlackMessage }>(
				'chat.postMessage',
				{ channel, text, thread_ts: threadTs }
			);
			return {
				channel: res.channel,
				ts: res.ts,
				message: res.message ?? { ts: res.ts, text, thread_ts: threadTs }
			};
		},

		/** Recent messages that @mention the user, newest first. */
		async mentions(userId: string, count = 30): Promise<SlackSearchMatch[]> {
			const res = await call<{ messages: { matches: SlackSearchMatch[] } }>('search.messages', {
				query: `<@${userId}>`,
				sort: 'timestamp',
				sort_dir: 'desc',
				count
			});
			return res.messages.matches ?? [];
		},

		/** Messages and files matching a Slack search query (supports in:, from:, after:, before:). */
		async searchAll(query: string, page = 1, count = 20) {
			const res = await call<{
				messages?: { matches?: SlackSearchMatch[]; paging?: { pages?: number; total?: number } };
				files?: { matches?: SlackSearchFile[]; paging?: { pages?: number; total?: number } };
			}>('search.all', {
				query,
				page,
				count,
				sort: 'timestamp',
				sort_dir: 'desc',
				highlight: false
			});
			return {
				messages: res.messages?.matches ?? [],
				files: res.files?.matches ?? [],
				pages: Math.max(res.messages?.paging?.pages ?? 1, res.files?.paging?.pages ?? 1),
				total: (res.messages?.paging?.total ?? 0) + (res.files?.paging?.total ?? 0)
			};
		},

		async permalink(channel: string, ts: string) {
			const res = await call<{ permalink: string }>('chat.getPermalink', {
				channel,
				message_ts: ts
			});
			return res.permalink;
		},

		/** Display name for a conversation: #channel, or the DM partner's name. */
		async channelName(channel: string): Promise<string> {
			const c = await client.conversationInfo(channel);
			if (c.is_im && c.user) return (await client.user(c.user)).name;
			if (c.is_mpim) return 'Group DM';
			return `#${c.name ?? channel}`;
		},

		async user(id: string): Promise<SlackUser> {
			const hit = userCache.get(id);
			if (hit && Date.now() - hit.at < USER_TTL) return hit.user;
			try {
				const res = await call<{
					user: {
						id: string;
						name: string;
						real_name?: string;
						profile?: { display_name?: string; real_name?: string; image_48?: string };
					};
				}>('users.info', { user: id });
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
		async users(messages: { user?: string; text: string }[]) {
			const list = await Promise.all([...userIds(messages)].map((id) => client.user(id)));
			return Object.fromEntries(list.map((u) => [u.id, u]));
		}
	};
	return client;
}

export type SlackClient = ReturnType<typeof createSlackClient>;

/** Authors and <@mentions> referenced by messages. */
export function userIds(messages: { user?: string | null; text: string }[]) {
	const ids = new Set<string>();
	for (const m of messages) {
		if (m.user) ids.add(m.user);
		for (const x of m.text.matchAll(/<@([UW][A-Z0-9]+)/g)) ids.add(x[1]!);
	}
	return ids;
}

/** Jittered exponential backoff: ~0.5 s, 1 s, 2 s… */
function backoff(attempt: number) {
	return 500 * 2 ** attempt * (0.75 + Math.random() * 0.5);
}

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
	personalToken: {
		label: 'User OAuth token',
		createUrl: 'https://api.slack.com/apps',
		hint: 'Install your Slack app to the workspace, then copy the User OAuth Token (xoxp-…) from OAuth & Permissions.',
		pattern: /^xoxp-[A-Za-z0-9-]+$/,
		patternHint:
			'Paste a user token starting with xoxp- (bot tokens and browser tokens aren’t supported)'
	},
	authorizeUrl(cfg, state) {
		const u = new URL('https://slack.com/oauth/v2/authorize');
		u.searchParams.set('client_id', cfg.clientId);
		u.searchParams.set('user_scope', SLACK_USER_SCOPES.join(','));
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
		const client = createSlackClient(token);
		const me = await client.authTest();
		const profile = await client.user(me.userId);
		return {
			login: `${profile.name} · ${me.team}`,
			avatarUrl: profile.image,
			scopes: me.scopes,
			cursor: { userId: me.userId, teamId: me.teamId, teamName: me.team, teamUrl: me.url }
		};
	}
};

/** Required scopes the token lacks (from the comma-separated scopes Slack reported). */
export function missingSlackScopes(scopes: string | null | undefined) {
	if (!scopes) return [];
	const have = new Set(scopes.split(/[,\s]+/).filter(Boolean));
	return SLACK_USER_SCOPES.filter((s) => !have.has(s));
}
