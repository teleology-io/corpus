import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { calendarByFeedToken, exportEvents } from '#lib/server/calendar.js';
import { toIcs } from '#lib/server/ics.js';

/** Public, token-protected subscribable feed (webcal). */
export const GET: RequestHandler = async ({ params }) => {
	const cal = await calendarByFeedToken(params.token.replace(/\.ics$/, ''));
	if (!cal) error(404, 'Feed not found');
	const rows = await exportEvents(cal.workspaceId);
	const ics = toIcs(
		cal.name,
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
		headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'max-age=300' }
	});
};
