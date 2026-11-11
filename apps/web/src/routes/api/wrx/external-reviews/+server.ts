import { error, json } from '@sveltejs/kit';
import type { RequestEvent, RequestHandler } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { workbenchAllowed } from '#lib/server/wrx/access.js';
import {
	dismissFinding,
	getReviewerSettings,
	listExternalReviews,
	postGithubReview,
	previewGithubReview,
	saveReviewerSettings,
	setCustomComment,
	startExternalReview
} from '#lib/server/pr-review/service.js';

// Reviews spawn agent CLIs on the host, so they sit behind the same check as the rest of Workbench.
function allowed({ locals }: RequestEvent) {
	const ctx = requireCtx(locals);
	if (!workbenchAllowed(ctx.user.email)) error(403, 'Workbench is not enabled for this account');
	return ctx.userId;
}

export const GET: RequestHandler = async (event) => json(await listExternalReviews(allowed(event)));

export const POST: RequestHandler = async (event) => {
	const userId = allowed(event);
	const body = (await event.request.json()) as Record<string, string>;
	switch (body.action) {
		case 'start':
			return json(await startExternalReview(userId, body.itemId));
		case 'dismiss':
			await dismissFinding(userId, body.reviewId, body.findingId);
			return json({});
		case 'comment':
			await setCustomComment(userId, body.reviewId, body.findingId, body.text);
			return json({});
		case 'preview':
			return json(await previewGithubReview(userId, body.reviewId));
		case 'post':
			return json(await postGithubReview(userId, body.reviewId));
		case 'settings':
			return json(getReviewerSettings(userId));
		case 'save-settings':
			saveReviewerSettings(userId, body.reviewers);
			return json({});
		default:
			error(400, 'Unknown action');
	}
};
