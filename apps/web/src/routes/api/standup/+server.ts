import { error } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { getSettings } from '#lib/server/settings.js';
import { collectStandup } from '#lib/server/standup/collect.js';
import { generateHosted, HOSTED_LABEL } from '#lib/server/standup/hosted.js';
import { MAX_SNAPSHOT_BYTES, signSnapshot, verifySnapshot } from '#lib/server/standup/sign.js';
import { workbenchAllowed } from '#lib/server/wrx/access.js';
import { validatePlan } from '#lib/standup/model.js';

/** Collects a fresh evidence snapshot (read-only) and signs it for later generation calls. */
export const GET: RequestHandler = async ({ locals }) => {
	const ctx = requireCtx(locals);
	const { 'standup.enabled': enabled } = await getSettings(ctx.userId, ['standup.enabled']);
	if (!enabled) error(403, 'Standup is turned off in Settings');
	const snapshot = await collectStandup(ctx);
	const signed = signSnapshot(snapshot);
	return Response.json({
		...signed,
		hosted: workbenchAllowed(ctx.user.email) ? { label: HOSTED_LABEL } : null
	});
};

const generateInput = z.object({
	payload: z.string().max(MAX_SNAPSHOT_BYTES + 1),
	signature: z.string().max(200),
	detail: z.enum(['compact', 'verbose'])
});

/**
 * Hosted generation over an existing signed snapshot (never re-collects). Returns the validated
 * plan or the validation errors; the client renders, and falls back to the template on failure.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const ctx = requireCtx(locals);
	const input = await body(request, generateInput);
	const verified = verifySnapshot(ctx.userId, input.payload, input.signature);
	if (!verified.ok) error(verified.status, verified.message);
	// Access is rechecked now, not trusted from when the snapshot was made.
	if (!workbenchAllowed(ctx.user.email)) error(403, 'Hosted generation needs Workbench access');
	const run = await generateHosted(verified.snapshot, input.detail);
	if (run.error) return Response.json({ ok: false, errors: [run.error], label: HOSTED_LABEL });
	const result = validatePlan(verified.snapshot, run.text, input.detail);
	return Response.json({ ...result, label: HOSTED_LABEL });
};
