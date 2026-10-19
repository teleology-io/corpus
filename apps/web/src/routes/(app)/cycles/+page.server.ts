import type { PageServerLoad } from './$types';
import {
	addDaysToDate,
	describeCycle,
	localDate,
	phaseOn,
	phaseSegments,
	rulePreset,
	describeRule
} from '@corpus/core';
import { requireCtx } from '#lib/server/ctx.js';
import { listCycles, listReminders } from '#lib/server/planner.js';

export const load: PageServerLoad = async ({ locals }) => {
	const ctx = requireCtx(locals);
	const today = localDate(new Date(), ctx.tz);
	const [cycles, reminders] = await Promise.all([listCycles(ctx), listReminders(ctx)]);
	const timelineStart = addDaysToDate(today, -28);
	const timelineEnd = addDaysToDate(today, 90);
	return {
		title: 'Cycles & Reminders',
		today,
		timeline: { start: timelineStart, end: timelineEnd },
		cycles: cycles.map((c) => {
			const def = { ...c, doseTimes: c.doseTimes.map((t) => t.slice(0, 5)) };
			return {
				...def,
				summary: describeCycle(c),
				phase: phaseOn(def, today),
				segments: phaseSegments(def, timelineStart, timelineEnd)
			};
		}),
		reminders: reminders.map((r) => ({
			...r,
			repeat: rulePreset(r.rrule),
			repeatText: describeRule(r.rrule)
		}))
	};
};
