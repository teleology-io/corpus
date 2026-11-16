import { addDaysToDate, atLocal, localDate } from '@corpus/core';

/** Mondays cover the previous Monday 00:00 → today 00:00 (weekend included); other days, yesterday. */
export function standupWindow(tz: string, now = new Date()) {
	const today = localDate(now, tz);
	const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
	const monday = weekday === 1;
	const fromDate = addDaysToDate(today, monday ? -7 : -1);
	return {
		label: (monday ? 'Last week' : 'Yesterday') as 'Last week' | 'Yesterday',
		today,
		from: atLocal(fromDate, '00:00', tz),
		to: atLocal(today, '00:00', tz),
		todayEnd: atLocal(addDaysToDate(today, 1), '00:00', tz)
	};
}
