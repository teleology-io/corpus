import { github } from './github';
import { linear } from './linear';
import { googleCalendar } from './google';
import { slack } from './slack';
import type { Provider, ProviderId } from './types';

export * from './types';
export * from './diff';
export * from './google';
export * from './slack';

export const PROVIDERS: Record<ProviderId, Provider> = {
	github,
	linear,
	'google-calendar': googleCalendar,
	slack
};

/** `{PREFIX}_CLIENT_ID` / `{PREFIX}_CLIENT_SECRET` env names for a provider. */
export function envPrefix(id: string) {
	return getProvider(id)?.envPrefix ?? id.toUpperCase().replace(/-/g, '_');
}

export function getProvider(id: string): Provider | undefined {
	return PROVIDERS[id as ProviderId];
}

/** Catalog for the Integrations page; `available: false` renders as "coming soon". */
export const INTEGRATION_CATALOG = [
	{
		id: 'github',
		name: 'GitHub',
		description: 'Review requests, your pull requests and assigned issues.',
		available: true
	},
	{
		id: 'linear',
		name: 'Linear',
		description: 'Issues assigned to you, with status and due dates.',
		available: true
	},
	{
		id: 'google-calendar',
		name: 'Google Calendar',
		description: 'Two-way sync: Google events in your calendar, your edits back to Google.',
		available: true
	},
	{
		id: 'slack',
		name: 'Slack',
		description: 'Mentions and followed threads — read and reply without leaving Corpus.',
		available: true
	},
	{ id: 'jira', name: 'Jira', description: 'Assigned issues and sprint work.', available: false },
	{ id: 'todoist', name: 'Todoist', description: 'Import tasks and due dates.', available: false }
] as const;
