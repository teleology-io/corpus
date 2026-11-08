import type { PageServerLoad } from './$types';
import { INTEGRATION_CATALOG, getProvider, missingSlackScopes } from '@corpus/core/integrations';
import { isInstanceAdmin, oauthApps, redirectUri } from '@corpus/db/apps';
import { requireCtx } from '#lib/server/ctx.js';
import { envPrefix, listConnections, openItems } from '#lib/server/integrations.js';
import { unreadThreadCount } from '#lib/server/slack.js';

export const load: PageServerLoad = async ({ locals, url, depends }) => {
	depends('app:integrations', 'app:integration-status');
	const ctx = requireCtx(locals);
	const [connections, items, slackUnread, apps, isAdmin] = await Promise.all([
		listConnections(ctx.userId),
		openItems(ctx.userId, { limit: 200 }),
		unreadThreadCount(ctx.userId),
		oauthApps(INTEGRATION_CATALOG.map((p) => p.id)),
		isInstanceAdmin(ctx.user)
	]);
	return {
		title: 'Integrations',
		isAdmin,
		catalog: INTEGRATION_CATALOG.map((p) => {
			const provider = getProvider(p.id);
			return {
				...p,
				configured: p.available && !!apps[p.id]?.source,
				app: {
					...apps[p.id]!,
					envPrefix: envPrefix(p.id),
					redirectUri: redirectUri(p.id),
					setupUrl: provider?.appSetupUrl ?? null
				},
				// RegExp `pattern` stays server side (it's checked on submit).
				personalToken: provider?.personalToken
					? {
							label: provider.personalToken.label,
							createUrl: provider.personalToken.createUrl,
							hint: provider.personalToken.hint
						}
					: null
			};
		}),
		connections: connections.map(({ scopes, ...c }) => ({
			...c,
			lastPolledAt: c.lastPolledAt?.toISOString() ?? null,
			missingScopes: c.provider === 'slack' ? missingSlackScopes(scopes) : []
		})),
		items,
		slackUnread,
		connected: url.searchParams.get('connected'),
		error: url.searchParams.get('error')
	};
};
