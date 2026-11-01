import { dev } from '$app/env';
import { optionalEnv } from '@corpus/db';

/**
 * Workbench runs git, agent CLIs and Colima on the host as the server's OS user, so it is
 * opt-in per account: WRX_ALLOWED_EMAILS (comma-separated) lists who may use it. Unset, it
 * is open to every signed-in user in dev and closed in production.
 */
export function workbenchAllowed(email: string) {
	const list = optionalEnv('WRX_ALLOWED_EMAILS');
	if (!list) return dev;
	return list
		.split(',')
		.map((e) => e.trim().toLowerCase())
		.includes(email.toLowerCase());
}
