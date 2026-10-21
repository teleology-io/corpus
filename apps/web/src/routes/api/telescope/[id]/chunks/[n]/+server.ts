import type { RequestHandler } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { writeLocalPart } from '#lib/server/telescope.js';

/** Local storage driver only — the R2 driver uploads parts straight to the bucket. */
export const PUT: RequestHandler = async ({ locals, request, params }) => {
	const etag = await writeLocalPart(requireCtx(locals), params.id, Number(params.n), request);
	return new Response(null, { status: 200, headers: { ETag: etag } });
};
