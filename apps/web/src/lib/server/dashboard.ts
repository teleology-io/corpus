import { addDaysToDate, atLocal, localDate, phaseOn, describeCycle } from '@corpus/core';
import type { OccurrenceDTO } from '#lib/types.js';
import type { Ctx } from './ctx.js';
import { listOccurrences } from './calendar.js';
import { openItems } from './integrations.js';
import { listThreads } from './slack.js';
import { completedBetween, doses, listCycles, listTasks, reminderOccurrences } from './planner.js';
import { workbenchAllowed } from './wrx/access.js';
import { workbenchTasks } from './wrx/index.js';

export function dayBounds(tz: string, now = new Date()) {
	const today = localDate(now, tz);
	const yesterday = addDaysToDate(today, -1);
	const tomorrow = addDaysToDate(today, 1);
	return {
		today,
		tomorrow,
		yesterdayStart: atLocal(yesterday, '00:00', tz),
		todayStart: atLocal(today, '00:00', tz),
		tomorrowStart: atLocal(tomorrow, '00:00', tz),
		dayAfterStart: atLocal(addDaysToDate(today, 2), '00:00', tz)
	};
}

/** Same window rule as `expand()`: overlaps [from, to), or a zero-length event starting inside. */
function overlaps(o: OccurrenceDTO, from: Date, to: Date) {
	const s = new Date(o.start).getTime();
	const e = new Date(o.end).getTime();
	if (e > from.getTime() && s < to.getTime()) return true;
	return e === s && s >= from.getTime() && s < to.getTime();
}

export async function dashboard(ctx: Ctx) {
	const b = dayBounds(ctx.tz);
	// Shared between the cycle list and both dose lookups (was queried three times).
	const cyclesP = listCycles(ctx);

	const [
		events,
		tasksToday,
		tasksTomorrow,
		remindersToday,
		remindersTomorrow,
		dosesToday,
		dosesTomorrow,
		completedToday,
		completedYesterday,
		cycles,
		items,
		threads
	] = await Promise.all([
		// One expansion over both days, split below (each call is ~6 queries).
		listOccurrences(ctx, b.todayStart, b.dayAfterStart),
		listTasks(ctx, {
			from: b.todayStart,
			to: b.tomorrowStart,
			includeOverdue: true,
			includeUndated: true
		}),
		listTasks(ctx, { from: b.tomorrowStart, to: b.dayAfterStart, completed: false }),
		reminderOccurrences(ctx, b.todayStart, b.tomorrowStart),
		reminderOccurrences(ctx, b.tomorrowStart, b.dayAfterStart),
		cyclesP.then((c) => doses(ctx, b.todayStart, b.tomorrowStart, c)),
		cyclesP.then((c) => doses(ctx, b.tomorrowStart, b.dayAfterStart, c)),
		completedBetween(ctx, b.todayStart, b.tomorrowStart),
		completedBetween(ctx, b.yesterdayStart, b.todayStart),
		cyclesP,
		openItems(ctx.userId, { limit: 30 }),
		listThreads(ctx.userId, 50)
	]);

	const eventsToday = events.filter((o) => overlaps(o, b.todayStart, b.tomorrowStart));
	const eventsTomorrow = events.filter((o) => overlaps(o, b.tomorrowStart, b.dayAfterStart));

	// Workbench boards have no due dates: everything open is on today's list, plus what got done today.
	const doneIn = (at: string | null, from: Date, to: Date) =>
		!!at && new Date(at) >= from && new Date(at) < to;
	const allWorkbench = workbenchAllowed(ctx.user.email) ? workbenchTasks(ctx.userId) : [];
	const workbench = allWorkbench
		.filter((t) => t.status !== 'done' || doneIn(t.completedAt, b.todayStart, b.tomorrowStart))
		.sort(
			(a, c) =>
				+(a.status === 'done') - +(c.status === 'done') || a.createdAt.localeCompare(c.createdAt)
		);
	const workbenchDone = (from: Date, to: Date) =>
		allWorkbench.filter((t) => t.status === 'done' && doneIn(t.completedAt, from, to)).length;

	const openToday =
		tasksToday.filter((t) => !t.completedAt).length +
		workbench.filter((t) => t.status !== 'done').length;
	const dosesTaken = dosesToday.filter((d) => d.status === 'taken').length;

	return {
		date: b.today,
		tomorrowDate: b.tomorrow,
		stats: {
			completedToday: completedToday + workbenchDone(b.todayStart, b.tomorrowStart),
			completedYesterday: completedYesterday + workbenchDone(b.yesterdayStart, b.todayStart),
			openToday,
			eventsToday: eventsToday.length,
			doses: { taken: dosesTaken, total: dosesToday.length }
		},
		today: {
			events: eventsToday,
			tasks: tasksToday,
			workbench,
			reminders: remindersToday,
			doses: dosesToday
		},
		tomorrow: {
			events: eventsTomorrow,
			tasks: tasksTomorrow,
			reminders: remindersTomorrow,
			doses: dosesTomorrow
		},
		cycles: cycles
			.filter((c) => !c.pausedAt)
			.map((c) => ({
				id: c.id,
				name: c.name,
				color: c.color,
				summary: describeCycle(c),
				phase: phaseOn({ ...c, doseTimes: [] }, b.today)
			})),
		items,
		slackThreads: threads.filter((t) => t.unread)
	};
}
