import type { Handle } from '@sveltejs/kit/hooks';
import { building } from '$app/env';
import { auth } from '@corpus/auth';
import { db, env, user } from '@corpus/db';
import { eq } from 'drizzle-orm';

/**
 * The admin panel has no sign-in of its own. It reads the main app's session cookie (cookies are
 * shared across ports on the same host) and then checks the `superadmin` flag in the database on
 * every request, so revoking access takes effect immediately.
 */
const appUrl = env('PUBLIC_APP_URL', 'http://localhost:2222');

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.admin = null;
	if (building) return resolve(event);

	const session = await auth.api.getSession({ headers: event.request.headers });
	if (!session || new Date(session.session.expiresAt).getTime() <= Date.now()) {
		return page(
			401,
			'Sign in required',
			`Sign in to Corpus first, then reload this page.`,
			`${appUrl}/sign-in`
		);
	}

	const [row] = await db
		.select({ superadmin: user.superadmin })
		.from(user)
		.where(eq(user.id, session.user.id))
		.limit(1);
	if (!row?.superadmin) {
		return page(403, 'No access', 'This account is not a Corpus superadmin.', appUrl);
	}

	const { id, name, email, image } = session.user;
	event.locals.admin = { id, name, email, image: image ?? null };
	return resolve(event);
};

/** Bare page, rendered without the app shell so nothing about the panel leaks to non-admins. */
function page(status: number, title: string, body: string, href: string) {
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${title}</title>
<style>body{font-family:'Plus Jakarta Sans',system-ui,sans-serif;background:#f7f8fa;color:#111827;display:grid;place-items:center;min-height:100vh;margin:0}
main{background:#fff;border:1px solid #e9ebef;border-radius:14px;padding:32px 40px;text-align:center}h1{font-size:18px;margin:0 0 8px}p{color:#6b7280;margin:0 0 20px}
a{background:#2c87f2;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-weight:600;font-size:14px}</style></head>
<body><main><h1>${title}</h1><p>${body}</p><a href="${href}">Open Corpus</a></main></body></html>`;
	return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
