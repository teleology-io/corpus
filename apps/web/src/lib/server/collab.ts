import { optionalEnv } from '@corpus/db';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Collab websocket URL for this request. A localhost URL is rewritten to the host the browser
 * used, so a machine on the LAN connects to this server rather than to its own localhost.
 */
export function collabUrl(page: URL): string {
	const url = new URL(optionalEnv('PUBLIC_COLLAB_URL') ?? 'ws://localhost:1234');
	if (LOOPBACK.has(url.hostname) && !LOOPBACK.has(page.hostname)) url.hostname = page.hostname;
	return url.toString().replace(/\/$/, '');
}
