import { error } from '@sveltejs/kit';
import { logAction } from '#lib/server/actions.js';
import { retryConnection } from '#lib/server/actions.js';
import { connections, providers } from '#lib/server/queries.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const provider = url.searchParams.get('provider');
	const [list, conns] = await Promise.all([
		providers(),
		provider ? connections(provider) : Promise.resolve(null)
	]);
	return { providers: list, provider, connections: conns };
};

export const actions: Actions = {
	retry: async ({ request, locals }) => {
		const id = String((await request.formData()).get('id') ?? '');
		const row = await retryConnection(id);
		if (!row) error(404, 'Connection not found or revoked');
		await logAction(locals.admin!, 'connection.retry', {
			type: 'connection',
			id,
			label: `${row.provider} connection`
		});
	}
};
