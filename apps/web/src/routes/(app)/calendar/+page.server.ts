import type { PageServerLoad } from './$types';
import { atLocal, localDate } from '@corpus/core';
import { requireCtx } from '#lib/server/ctx.js';
import {
	ensureFeedToken,
	listCalendars,
	listCategories,
	listOccurrences
} from '#lib/server/calendar.js';
import { cycleBands, doses, reminderOccurrences } from '#lib/server/planner.js';
import { viewRange, type View } from '#lib/calendar.js';

export const load: PageServerLoad = async ({ locals, url }) => {
	const ctx = requireCtx(locals);
	const view = (
		['week', 'month', 'year'].includes(url.searchParams.get('view') ?? '')
			? url.searchParams.get('view')
			: 'week'
	) as View;
	const today = localDate(new Date(), ctx.tz);
	const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date') ?? '')
		? url.searchParams.get('date')!
		: today;
	const q = url.searchParams.get('q')?.trim() || undefined;
	const range = viewRange(view, date, ctx.user.weekStartsOn ?? 0);
	const from = atLocal(range.start, '00:00', ctx.tz);
	const to = atLocal(range.end, '00:00', ctx.tz);

	const [occurrences, categories, calendars, bands, doseList, reminders, feedToken] =
		await Promise.all([
			listOccurrences(ctx, from, to, { search: q }),
			listCategories(ctx.workspaceId),
			listCalendars(ctx.workspaceId),
			view === 'year' ? Promise.resolve([]) : cycleBands(ctx, range.start, range.end),
			view === 'week' ? doses(ctx, from, to) : Promise.resolve([]),
			view === 'week' ? reminderOccurrences(ctx, from, to) : Promise.resolve([]),
			ensureFeedToken(ctx)
		]);

	return {
		title: 'My Calendar',
		view,
		date,
		today,
		q: q ?? '',
		range,
		occurrences,
		categories,
		calendars,
		bands,
		doses: doseList,
		reminders,
		feedUrl: `${url.origin}/calendar/feed/${feedToken}.ics`,
		focusEvent: url.searchParams.get('event')
	};
};
