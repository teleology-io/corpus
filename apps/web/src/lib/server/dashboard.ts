import { addDaysToDate, atLocal, localDate, phaseOn, describeCycle } from '@corpus/core';
import type { Ctx } from './ctx.js';
import { listOccurrences } from './calendar.js';
import { openItems } from './integrations.js';
import { listThreads } from './slack.js';
import { completedBetween, doses, listCycles, listTasks, reminderOccurrences } from './planner.js';

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

export async function dashboard(ctx: Ctx) {
	const b = dayBounds(ctx.tz);

	const [
		eventsToday,
		eventsTomorrow,
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
		listOccurrences(ctx, b.todayStart, b.tomorrowStart),
		listOccurrences(ctx, b.tomorrowStart, b.dayAfterStart),
		listTasks(ctx, {
			from: b.todayStart,
			to: b.tomorrowStart,
			includeOverdue: true,
			includeUndated: true
		}),
		listTasks(ctx, { from: b.tomorrowStart, to: b.dayAfterStart, completed: false }),
		reminderOccurrences(ctx, b.todayStart, b.tomorrowStart),
		reminderOccurrences(ctx, b.tomorrowStart, b.dayAfterStart),
		doses(ctx, b.todayStart, b.tomorrowStart),
		doses(ctx, b.tomorrowStart, b.dayAfterStart),
		completedBetween(ctx, b.todayStart, b.tomorrowStart),
		completedBetween(ctx, b.yesterdayStart, b.todayStart),
		listCycles(ctx),
		openItems(ctx.userId, { limit: 30 }),
		listThreads(ctx.userId, 50)
	]);

	const openToday = tasksToday.filter((t) => !t.completedAt).length;
	const dosesTaken = dosesToday.filter((d) => d.status === 'taken').length;

	return {
		date: b.today,
		tomorrowDate: b.tomorrow,
		stats: {
			completedToday,
			completedYesterday,
			openToday,
			eventsToday: eventsToday.length,
			doses: { taken: dosesTaken, total: dosesToday.length }
		},
		today: { events: eventsToday, tasks: tasksToday, reminders: remindersToday, doses: dosesToday },
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
