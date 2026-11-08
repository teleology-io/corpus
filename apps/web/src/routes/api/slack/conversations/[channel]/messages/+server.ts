import { error } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { getMessages, sendMessage } from '#lib/server/slack-connector.js';

const CHANNEL = /^[CDG][A-Z0-9]{2,30}$/;
const TS = /^\d{9,11}\.\d{1,6}$/;

const ts = (v: string | null) => {
	if (!v) return undefined;
	if (!TS.test(v)) error(400, 'Bad timestamp');
	return v;
};

/** `?since=<ts>&changedSince=<iso>` polls for new messages; `?before=<ts>` loads older ones. */
export const GET: RequestHandler = async ({ locals, params, url }) => {
	if (!CHANNEL.test(params.channel)) error(400, 'Bad conversation id');
	const q = url.searchParams;
	return Response.json(
		await getMessages(requireCtx(locals).userId, params.channel, {
			since: ts(q.get('since')),
			before: ts(q.get('before')),
			changedSince: q.get('changedSince')?.slice(0, 40) || undefined
		})
	);
};

export const POST: RequestHandler = async ({ locals, request, params }) => {
	if (!CHANNEL.test(params.channel)) error(400, 'Bad conversation id');
	const { text, threadTs } = await body(
		request,
		z.object({
			text: z.string().trim().min(1).max(12_000),
			threadTs: z.string().regex(TS).optional()
		})
	);
	return Response.json(
		await sendMessage(requireCtx(locals).userId, params.channel, text, threadTs),
		{ status: 201 }
	);
};
