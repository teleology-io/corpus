import type { RequestHandler } from './$types';
import { requireCtx } from '#lib/server/ctx.js';
import { exportEvents } from '#lib/server/calendar.js';
import { toIcs } from '#lib/server/ics.js';

export const GET: RequestHandler = async ({ locals }) => {
	const ctx = requireCtx(locals);
	const rows = await exportEvents(ctx.workspaceId);
	const ics = toIcs(
		'Corpus',
		rows.map((r) => ({
			uid: r.id,
			title: r.title,
			description: r.description,
			location: r.location,
			start: r.startsAt,
			end: r.endsAt,
			allDay: r.allDay,
			rrule: r.rrule,
			exdates: r.exdates,
			timezone: r.timezone,
			updatedAt: r.updatedAt
		}))
	);
	return new Response(ics, {
		headers: {
			'Content-Type': 'text/calendar; charset=utf-8',
			'Content-Disposition': 'attachment; filename="corpus.ics"'
		}
	});
};
