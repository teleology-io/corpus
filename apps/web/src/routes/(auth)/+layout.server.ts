import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { optionalEnv } from '@corpus/db';

export const load: LayoutServerLoad = ({ locals, url }) => {
	if (locals.user && !url.pathname.startsWith('/two-factor')) redirect(303, '/dashboard');
	return { githubEnabled: !!optionalEnv('GITHUB_CLIENT_ID') };
};
