import { redirect } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit/hooks';
import { sequence } from '@sveltejs/kit/hooks';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { building } from '$app/env';
import { auth, resolveWorkspace } from '@corpus/auth';

const PUBLIC_PATHS = [
	'/sign-in',
	'/sign-up',
	'/two-factor',
	'/share/',
	'/v/',
	'/uploads/',
	'/api/auth/',
	'/calendar/feed/',
	'/manifest.webmanifest',
	'/favicon.svg',
	'/sw.js'
];

type Resolved = {
	user: App.Locals['user'];
	session: App.Locals['session'];
	workspaceId: string | null;
};

/**
 * Short-lived per-process cache of session + workspace resolution, keyed by the raw cookie
 * header. Every request (page data, API calls, hover preloads) otherwise pays two to three
 * sequential DB round trips before route code runs. In-flight lookups are shared so a burst
 * of parallel requests resolves once. Every non-GET request clears the cache once it has
 * run, so sign-out, workspace switches, profile edits and membership changes are seen by the
 * very next request. Sessions are never used past their expiry.
 */
const SESSION_TTL_MS = 10_000;
const sessionCache = new Map<string, { at: number; value: Promise<Resolved> }>();

async function lookup(headers: Headers): Promise<Resolved> {
	const result = await auth.api.getSession({ headers });
	// Sign-up creates the session before the personal workspace exists, and a workspace can
	// be deleted or left later — so resolve (and repair) the active workspace per request.
	return {
		user: result?.user ?? null,
		session: result?.session ?? null,
		workspaceId: result ? await resolveWorkspace(result.user, result.session) : null
	};
}

function resolveSession(event: Parameters<Handle>[0]['event']): Promise<Resolved> {
	const cookie = event.request.headers.get('cookie');
	// Auth routes (sign-in/out, session management) always read fresh state.
	const cacheable = !!cookie && !event.url.pathname.startsWith('/api/auth/');
	if (!cacheable) return lookup(event.request.headers);
	const now = Date.now();
	const hit = sessionCache.get(cookie);
	if (hit && now - hit.at < SESSION_TTL_MS) return hit.value;
	const value = lookup(event.request.headers);
	sessionCache.set(cookie, { at: now, value });
	value.catch(() => sessionCache.delete(cookie));
	if (sessionCache.size > 1000) {
		for (const [k, v] of sessionCache) if (now - v.at >= SESSION_TTL_MS) sessionCache.delete(k);
	}
	return value;
}

const authHandle: Handle = async ({ event, resolve }) => {
	if (!building) {
		const resolved = await resolveSession(event);
		const expired =
			resolved.session && new Date(resolved.session.expiresAt).getTime() <= Date.now();
		event.locals.user = expired ? null : resolved.user;
		event.locals.session = expired ? null : resolved.session;
		event.locals.workspaceId = expired ? null : resolved.workspaceId;
	}
	try {
		return await svelteKitHandler({ event, resolve, auth, building });
	} finally {
		// Mutations may change the session, user or membership the cache holds.
		if (event.request.method !== 'GET' && event.request.method !== 'HEAD') sessionCache.clear();
	}
};

const guard: Handle = async ({ event, resolve }) => {
	const path = event.url.pathname;
	const isPublic = path === '/' || PUBLIC_PATHS.some((p) => path.startsWith(p));
	if (!event.locals.user && !isPublic) {
		if (path.startsWith('/api/')) return new Response('Unauthorized', { status: 401 });
		redirect(303, `/sign-in?next=${encodeURIComponent(path + event.url.search)}`);
	}
	return resolve(event);
};

export const handle = sequence(authHandle, guard);
