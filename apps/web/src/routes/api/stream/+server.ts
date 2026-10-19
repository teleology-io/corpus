import type { RequestHandler } from './$types';
import { sql, userChannel } from '@corpus/db';
import { requireCtx } from '#lib/server/ctx.js';

/**
 * Server-sent events: relays Postgres NOTIFY messages on the user's channel
 * (new notifications, integration item changes, dashboard invalidations).
 */
export const GET: RequestHandler = async ({ locals, request }) => {
	const ctx = requireCtx(locals);
	const encoder = new TextEncoder();
	let cleanup = () => {};

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (chunk: string) => {
				try {
					controller.enqueue(encoder.encode(chunk));
				} catch {
					cleanup();
				}
			};
			const listener = await sql.listen(userChannel(ctx.userId), (payload) =>
				send(`data: ${payload}\n\n`)
			);
			const ping = setInterval(() => send(': ping\n\n'), 25_000);
			send('retry: 5000\n\n');
			cleanup = () => {
				clearInterval(ping);
				void listener.unlisten().catch(() => {});
				cleanup = () => {};
			};
			request.signal.addEventListener('abort', () => {
				cleanup();
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			});
		},
		cancel() {
			cleanup();
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
};
