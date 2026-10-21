import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { saveTranscript, transcriptInput } from '#lib/server/telescope.js';

export const PUT: RequestHandler = async ({ locals, request, params }) => {
	const ctx = requireCtx(locals);
	await saveTranscript(ctx, params.id, await body(request, transcriptInput));
	return new Response(null, { status: 204 });
};
