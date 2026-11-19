import { z } from 'zod';
import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import {
	board,
	COLUMNS,
	confirmPlan,
	moveCard,
	requireConductor,
	sendBack,
	startTicket
} from '#lib/server/conductor.js';
import { setSetting } from '#lib/server/settings.js';

export const GET: RequestHandler = async ({ locals }) => {
	const ctx = requireCtx(locals);
	requireConductor(ctx.user.email);
	return Response.json(await board(ctx.userId));
};

const input = z.discriminatedUnion('action', [
	z.object({ action: z.literal('plan'), cardIds: z.array(z.string().uuid()).max(100) }),
	z.object({ action: z.literal('move'), cardId: z.string().uuid(), column: z.enum(COLUMNS) }),
	z.object({
		action: z.literal('send_back'),
		cardId: z.string().uuid(),
		note: z.string().trim().min(1).max(4000)
	}),
	z.object({
		action: z.literal('start'),
		cardId: z.string().uuid(),
		repoPaths: z.array(z.string().max(4096)).max(20).optional()
	}),
	z.object({
		action: z.literal('settings'),
		repoPath: z.string().trim().max(4000).optional(),
		readyWhen: z.enum(['draft_pr', 'ci_green']).optional(),
		preReview: z.boolean().optional(),
		repoNotes: z.record(z.string().max(4096), z.string().trim().max(500)).optional()
	})
]);

export const POST: RequestHandler = async ({ locals, request }) => {
	const ctx = requireCtx(locals);
	requireConductor(ctx.user.email);
	const i = await body(request, input);
	switch (i.action) {
		case 'plan':
			await confirmPlan(ctx.userId, ctx.tz, i.cardIds);
			break;
		case 'move':
			await moveCard(ctx.userId, i.cardId, i.column);
			break;
		case 'send_back':
			await sendBack(ctx.userId, i.cardId, i.note);
			break;
		case 'start':
			await startTicket(ctx.userId, i.cardId, i.repoPaths);
			break;
		case 'settings':
			if (i.repoPath !== undefined) await setSetting(ctx.userId, 'conductor.repoPath', i.repoPath);
			if (i.readyWhen) await setSetting(ctx.userId, 'conductor.readyWhen', i.readyWhen);
			if (i.preReview !== undefined)
				await setSetting(ctx.userId, 'conductor.preReview', i.preReview);
			if (i.repoNotes)
				await setSetting(
					ctx.userId,
					'conductor.repoNotes',
					JSON.stringify(Object.fromEntries(Object.entries(i.repoNotes).filter(([, v]) => v)))
				);
			break;
	}
	return Response.json(await board(ctx.userId));
};
