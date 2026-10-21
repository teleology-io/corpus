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

const authHandle: Handle = async ({ event, resolve }) => {
	if (!building) {
		const result = await auth.api.getSession({ headers: event.request.headers });
		event.locals.user = result?.user ?? null;
		event.locals.session = result?.session ?? null;
		// Sign-up creates the session before the personal workspace exists, and a workspace can
		// be deleted or left later — so resolve (and repair) the active workspace per request.
		event.locals.workspaceId = result ? await resolveWorkspace(result.user, result.session) : null;
	}
	return svelteKitHandler({ event, resolve, auth, building });
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
