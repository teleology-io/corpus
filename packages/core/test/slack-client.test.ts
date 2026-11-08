import { describe, expect, it, vi } from 'vitest';
import {
	ProviderAuthError,
	SlackApiError,
	createSlackClient,
	missingSlackScopes,
	slack
} from '../src/integrations';

const TOKEN = 'xoxp-secret-token-123';

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		headers: { 'content-type': 'application/json', ...init.headers }
	});
}

function client(
	responses: (Response | Error)[],
	hooks: Parameters<typeof createSlackClient>[1] = {}
) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init });
		const next = responses.shift();
		if (!next) throw new Error('no more responses');
		if (next instanceof Error) throw next;
		return next;
	});
	const c = createSlackClient(TOKEN, {
		fetch: fetch as unknown as typeof globalThis.fetch,
		sleep: async () => {},
		...hooks
	});
	return { c, calls, fetch };
}

describe('slack client', () => {
	it('reads with GET + bearer header, never puts the token in the URL', async () => {
		const { c, calls } = client([json({ ok: true, messages: [{ ts: '1.000001', text: 'hi' }] })]);
		const page = await c.history('C123', { oldest: '1.0', limit: 15 });
		expect(page.messages).toHaveLength(1);
		expect(calls[0]!.url).toContain('conversations.history?');
		expect(calls[0]!.url).toContain('oldest=1.0');
		expect(calls[0]!.url).not.toContain(TOKEN);
		expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe(
			`Bearer ${TOKEN}`
		);
		expect(calls[0]!.init!.method).toBeUndefined();
	});

	it('posts messages with a form POST and thread_ts, without as_user', async () => {
		const { c, calls } = client([
			json({
				ok: true,
				channel: 'C1',
				ts: '2.000001',
				message: { ts: '2.000001', text: 'yo', user: 'U1' }
			})
		]);
		const sent = await c.postMessage('C1', 'yo', '1.000001');
		expect(sent).toMatchObject({ channel: 'C1', ts: '2.000001' });
		const body = calls[0]!.init!.body as URLSearchParams;
		expect(calls[0]!.init!.method).toBe('POST');
		expect(body.get('thread_ts')).toBe('1.000001');
		expect(body.has('as_user')).toBe(false);
	});

	it('honours 429 Retry-After and reports it to the limiter', async () => {
		const onRateLimited = vi.fn();
		const { c } = client(
			[
				json({ ok: false, error: 'ratelimited' }, { status: 429, headers: { 'retry-after': '42' } })
			],
			{
				onRateLimited
			}
		);
		const err = await c.history('C1').catch((e) => e);
		expect(err).toBeInstanceOf(SlackApiError);
		expect(err.code).toBe('ratelimited');
		expect(err.retryAfterSec).toBe(42);
		expect(onRateLimited).toHaveBeenCalledWith('conversations.history', 42);
	});

	it('asks the limiter before every call', async () => {
		const acquire = vi.fn(async () => {
			throw new SlackApiError('ratelimited', 5);
		});
		const { c, fetch } = client([], { acquire, priority: 'background' });
		await expect(c.usersConversations()).rejects.toMatchObject({ code: 'ratelimited' });
		expect(acquire).toHaveBeenCalledWith('users.conversations', 'background');
		expect(fetch).not.toHaveBeenCalled();
	});

	it('treats auth failures as reconnect errors but missing_scope as a feature error', async () => {
		const { c } = client([
			json({ ok: false, error: 'token_revoked' }),
			json({ ok: false, error: 'missing_scope', needed: 'search:read' })
		]);
		await expect(c.history('C1')).rejects.toBeInstanceOf(ProviderAuthError);
		const err = await c.searchAll('x').catch((e) => e);
		expect(err).toBeInstanceOf(SlackApiError);
		expect(err.needed).toBe('search:read');
		expect(String(err.message)).not.toContain(TOKEN);
	});

	it('retries reads on 5xx / network errors but never retries posts', async () => {
		const { c, fetch } = client([
			new Error('socket hang up'),
			json({}, { status: 503 }),
			json({ ok: true, channels: [], response_metadata: { next_cursor: '' } })
		]);
		await expect(c.usersConversations()).resolves.toMatchObject({ items: [], nextCursor: null });
		expect(fetch).toHaveBeenCalledTimes(3);

		const post = client([json({}, { status: 500 }), json({ ok: true, ts: '1.1', channel: 'C' })]);
		await expect(post.c.postMessage('C', 'x')).rejects.toMatchObject({ code: 'http_500' });
		expect(post.fetch).toHaveBeenCalledTimes(1);
	});

	it('pages thread replies with cursors', async () => {
		const { c } = client([
			json({
				ok: true,
				messages: [{ ts: '1.0', text: 'root' }],
				response_metadata: { next_cursor: 'n1' }
			}),
			json({ ok: true, messages: [{ ts: '1.1', text: 'reply' }] })
		]);
		const msgs = await c.replies('C1', '1.0');
		expect(msgs.map((m) => m.ts)).toEqual(['1.0', '1.1']);
	});

	it('reads granted scopes from auth.test and rejects bot tokens', async () => {
		const { c } = client([
			json(
				{
					ok: true,
					user_id: 'U1',
					user: 'me',
					team: 'Acme',
					team_id: 'T1',
					url: 'https://acme.slack.com/'
				},
				{ headers: { 'x-oauth-scopes': 'channels:read,chat:write' } }
			),
			json({
				ok: true,
				user_id: 'U2',
				user: 'bot',
				team: 'Acme',
				team_id: 'T1',
				url: '',
				bot_id: 'B1'
			})
		]);
		await expect(c.authTest()).resolves.toMatchObject({
			userId: 'U1',
			scopes: 'channels:read,chat:write'
		});
		await expect(c.authTest()).rejects.toBeInstanceOf(ProviderAuthError);
	});
});

describe('slack token connect', () => {
	it('accepts only xoxp user tokens', () => {
		const re = slack.personalToken!.pattern!;
		expect(re.test('xoxp-1-2-3-abc')).toBe(true);
		expect(re.test('xoxb-1-2-abc')).toBe(false);
		expect(re.test('xoxc-1-2-abc')).toBe(false);
	});

	it('lists missing scopes from a granted-scope string', () => {
		expect(missingSlackScopes(null)).toEqual([]);
		expect(missingSlackScopes('channels:history')).toContain('channels:read');
		expect(
			missingSlackScopes(
				'search:read,channels:history,groups:history,im:history,mpim:history,channels:read,groups:read,im:read,mpim:read,users:read,chat:write'
			)
		).toEqual([]);
	});
});
