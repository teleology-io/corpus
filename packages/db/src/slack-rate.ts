/**
 * Shared Slack rate limiter: one token bucket per (connection, Web API method) in Postgres, so
 * the web app (open conversation) and the worker (background sync) draw from the same budget.
 *
 * Budgets sit below Slack's published tiers and adapt down on 429s. Background calls must leave
 * a reserve so the conversation the user is looking at always has headroom; with a 1/min bucket
 * (non-Marketplace distributed apps on conversations.history/replies) background calls never run.
 */
import { SlackApiError, type SlackHooks, type SlackPriority } from '@corpus/core/integrations';
import { and, eq } from 'drizzle-orm';
import { db, sql } from './index';
import { slackRateLimit } from './schema/index';

export type SlackRateProfile = 'auto' | 'internal' | 'distributed';

/** Methods subject to the 2025 non-Marketplace limits (1 req/min, 15 objects per page). */
const HISTORY_METHODS = new Set(['conversations.history', 'conversations.replies']);

/** Per-minute budgets, kept under each method's tier (T2 20+, T3 50+, T4 100+). */
const BUDGET: Record<string, number> = {
	'auth.test': 30,
	'conversations.history': 40,
	'conversations.replies': 40,
	'conversations.info': 40,
	'conversations.list': 15,
	'users.conversations': 40,
	'users.info': 80,
	'search.all': 15,
	'search.messages': 15,
	'chat.getPermalink': 80
};

/** chat.postMessage has its own per-channel limit; we only honour Slack's 429s for it. */
const UNMETERED = new Set(['chat.postMessage']);

/** Interactive callers wait at most this long for a token before getting `ratelimited`. */
const INTERACTIVE_WAIT_MS = 2_000;
/** Share of the bucket background calls must leave untouched. */
const BACKGROUND_RESERVE = 0.3;
/** Burst size cap (Slack recommends ~1 req/s per method with short bursts). */
const MAX_BURST = 10;

export function methodBudget(method: string, profile: SlackRateProfile = 'auto') {
	if (profile === 'distributed' && HISTORY_METHODS.has(method)) return 1;
	return BUDGET[method] ?? 20;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Take one token. Returns 0 when granted, otherwise the milliseconds until one would be.
 * Single statement: refill by elapsed time, cap at burst size, then spend — atomic per row.
 */
async function take(connectionId: string, method: string, budget: number, reserve: number) {
	await sql`
		insert into slack_rate_limit (connection_id, method, tokens, per_minute, refilled_at)
		values (${connectionId}, ${method}, ${Math.min(budget, MAX_BURST)}, ${budget}, now())
		on conflict (connection_id, method) do nothing`;
	const granted = await sql<{ tokens: number }[]>`
		update slack_rate_limit set
			per_minute = least(per_minute, ${budget}),
			tokens = least(greatest(1, least(least(per_minute, ${budget}), ${MAX_BURST})),
				tokens + extract(epoch from (now() - refilled_at)) * least(per_minute, ${budget}) / 60) - 1,
			refilled_at = now()
		where connection_id = ${connectionId} and method = ${method}
			and (blocked_until is null or blocked_until <= now())
			and least(greatest(1, least(least(per_minute, ${budget}), ${MAX_BURST})),
				tokens + extract(epoch from (now() - refilled_at)) * least(per_minute, ${budget}) / 60)
				>= 1 + ${reserve} * greatest(1, least(least(per_minute, ${budget}), ${MAX_BURST}))
		returning tokens`;
	if (granted.length) return 0;
	const [row] = await sql<
		{ tokens: number; per_minute: number; elapsed: number; blocked_ms: number; cap: number }[]
	>`
		select tokens, least(per_minute, ${budget}) as per_minute,
			extract(epoch from (now() - refilled_at)) as elapsed,
			greatest(0, extract(epoch from (blocked_until - now())) * 1000) as blocked_ms,
			greatest(1, least(least(per_minute, ${budget}), ${MAX_BURST})) as cap
		from slack_rate_limit where connection_id = ${connectionId} and method = ${method}`;
	if (!row) return 1_000;
	const rate = Number(row.per_minute) / 60;
	const have = Math.min(Number(row.cap), Number(row.tokens) + Number(row.elapsed) * rate);
	const need = 1 + reserve * Number(row.cap);
	// A background call that can never fit (bucket smaller than reserve + 1) waits a full minute.
	const refillMs = need > Number(row.cap) ? 60_000 : ((need - have) / rate) * 1000;
	return Math.max(Number(row.blocked_ms) || 0, refillMs, 50);
}

/** Record a 429: block the method until Retry-After and, for history/replies, halve the budget. */
export async function recordRateLimited(
	connectionId: string,
	method: string,
	retryAfterSec: number
) {
	const halve = HISTORY_METHODS.has(method);
	await sql`
		insert into slack_rate_limit (connection_id, method, tokens, per_minute, refilled_at, blocked_until)
		values (${connectionId}, ${method}, 0, ${halve ? methodBudget(method) / 2 : methodBudget(method)},
			now(), now() + make_interval(secs => ${retryAfterSec}))
		on conflict (connection_id, method) do update set
			tokens = 0,
			refilled_at = now() + make_interval(secs => ${retryAfterSec}),
			blocked_until = now() + make_interval(secs => ${retryAfterSec}),
			per_minute = ${halve ? sql`greatest(1, slack_rate_limit.per_minute / 2)` : sql`slack_rate_limit.per_minute`}`;
}

/**
 * True when conversations.history must be treated as Tier 1 (1/min, 15 per page): forced by the
 * connection's profile, or learned from repeated 429s.
 */
export async function historyRestricted(connectionId: string, profile: SlackRateProfile = 'auto') {
	if (profile === 'distributed') return true;
	if (profile === 'internal') return false;
	const [row] = await db
		.select({ perMinute: slackRateLimit.perMinute })
		.from(slackRateLimit)
		.where(
			and(
				eq(slackRateLimit.connectionId, connectionId),
				eq(slackRateLimit.method, 'conversations.history')
			)
		)
		.limit(1);
	return !!row && row.perMinute <= 2;
}

/** Forget learned limits (after the user changes the rate profile). */
export async function resetRateLimits(connectionId: string) {
	await db.delete(slackRateLimit).where(eq(slackRateLimit.connectionId, connectionId));
}

/** SlackHooks that meter calls through the shared buckets. */
export function rateLimitHooks(
	connectionId: string,
	priority: SlackPriority,
	profile: SlackRateProfile = 'auto'
): SlackHooks {
	return {
		priority,
		async acquire(method, p) {
			if (UNMETERED.has(method)) return;
			const budget = methodBudget(method, profile);
			const reserve = p === 'background' ? BACKGROUND_RESERVE : 0;
			let wait = await take(connectionId, method, budget, reserve);
			if (!wait) return;
			if (p === 'interactive' && wait <= INTERACTIVE_WAIT_MS) {
				await sleep(wait);
				wait = await take(connectionId, method, budget, reserve);
				if (!wait) return;
			}
			throw new SlackApiError('ratelimited', Math.ceil(wait / 1000));
		},
		onRateLimited(method, sec) {
			return recordRateLimited(connectionId, method, sec);
		}
	};
}
