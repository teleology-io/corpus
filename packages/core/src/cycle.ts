import { addDaysToDate, atLocal, diffDates, localDate } from './time';

export interface CycleDef {
	startDate: string;
	onDays: number;
	offDays: number;
	repeatCount: number | null;
	doseTimes: string[];
	timezone: string;
	pausedAt?: Date | null;
}

export type CyclePhase =
	| { status: 'not_started'; startsOn: string; daysUntil: number }
	| { status: 'finished'; endedOn: string }
	| {
			status: 'on' | 'off';
			cycleNumber: number; // 1-based
			dayOfPhase: number; // 1-based
			phaseLength: number;
			phaseStart: string;
			phaseEnd: string; // inclusive
			nextPhaseStart: string | null;
	  };

/** Phase of a cycle on a given local date (YYYY-MM-DD). Pausing is handled by callers. */
export function phaseOn(cycle: CycleDef, date: string): CyclePhase {
	const period = cycle.onDays + cycle.offDays;
	const idx = diffDates(cycle.startDate, date);
	if (idx < 0) return { status: 'not_started', startsOn: cycle.startDate, daysUntil: -idx };
	const cycleIdx = period > 0 ? Math.floor(idx / period) : 0;
	if (cycle.repeatCount != null && cycleIdx >= cycle.repeatCount) {
		return {
			status: 'finished',
			endedOn: addDaysToDate(cycle.startDate, cycle.repeatCount * period - 1)
		};
	}
	const inPeriod = period > 0 ? idx % period : idx;
	const cycleStart = addDaysToDate(cycle.startDate, cycleIdx * period);
	const isOn = inPeriod < cycle.onDays;
	const phaseStart = isOn ? cycleStart : addDaysToDate(cycleStart, cycle.onDays);
	const phaseLength = isOn ? cycle.onDays : cycle.offDays;
	const phaseEnd = addDaysToDate(phaseStart, phaseLength - 1);
	const isLast = cycle.repeatCount != null && cycleIdx === cycle.repeatCount - 1;
	const nextPhaseStart = !isOn && isLast ? null : addDaysToDate(phaseEnd, 1);
	return {
		status: isOn ? 'on' : 'off',
		cycleNumber: cycleIdx + 1,
		dayOfPhase: diffDates(phaseStart, date) + 1,
		phaseLength,
		phaseStart,
		phaseEnd,
		nextPhaseStart
	};
}

export function phaseAt(cycle: CycleDef, instant: Date): CyclePhase {
	return phaseOn(cycle, localDate(instant, cycle.timezone));
}

export function isOnDay(cycle: CycleDef, date: string) {
	return phaseOn(cycle, date).status === 'on';
}

/** All scheduled dose instants in [from, to). Paused cycles produce nothing after pausedAt. */
export function doseOccurrences(cycle: CycleDef, from: Date, to: Date): Date[] {
	if (!cycle.doseTimes.length) return [];
	const out: Date[] = [];
	let date = addDaysToDate(localDate(from, cycle.timezone), -1);
	const last = addDaysToDate(localDate(to, cycle.timezone), 1);
	while (diffDates(date, last) >= 0) {
		if (isOnDay(cycle, date)) {
			for (const t of cycle.doseTimes) {
				const at = atLocal(date, t, cycle.timezone);
				if (at < from || at >= to) continue;
				if (cycle.pausedAt && at >= cycle.pausedAt) continue;
				out.push(at);
			}
		}
		date = addDaysToDate(date, 1);
	}
	return out.sort((a, b) => a.getTime() - b.getTime());
}

/** Phase segments (on/off) intersecting [fromDate, toDate] — for calendar bands & timelines. */
export function phaseSegments(cycle: CycleDef, fromDate: string, toDate: string) {
	const segments: { status: 'on' | 'off'; start: string; end: string; cycleNumber: number }[] = [];
	let date = fromDate;
	while (diffDates(date, toDate) >= 0) {
		const p = phaseOn(cycle, date);
		if (p.status === 'on' || p.status === 'off') {
			const end = diffDates(p.phaseEnd, toDate) < 0 ? toDate : p.phaseEnd;
			segments.push({ status: p.status, start: date, end, cycleNumber: p.cycleNumber });
			date = addDaysToDate(end, 1);
		} else if (p.status === 'not_started') {
			date = p.startsOn;
		} else break;
	}
	return segments;
}

/** "6w on / 3w off" or "5d on / 2d off" */
export function describeCycle(c: Pick<CycleDef, 'onDays' | 'offDays'>) {
	const fmt = (d: number) => (d % 7 === 0 ? `${d / 7}w` : `${d}d`);
	return `${fmt(c.onDays)} on / ${fmt(c.offDays)} off`;
}
