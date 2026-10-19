import { describe, expect, it } from 'vitest';
import {
	expand,
	nextStart,
	presetRule,
	ruleUntil,
	rulePreset,
	truncateRule
} from '../src/recurrence';

const NY = 'America/New_York';

describe('expand', () => {
	it('returns a single non-recurring event when it overlaps', () => {
		const ev = {
			id: 'a',
			startsAt: new Date('2026-04-14T13:00:00Z'),
			endsAt: new Date('2026-04-14T14:00:00Z'),
			timezone: NY,
			rrule: null
		};
		expect(
			expand(ev, new Date('2026-04-14T00:00:00Z'), new Date('2026-04-15T00:00:00Z'))
		).toHaveLength(1);
		expect(
			expand(ev, new Date('2026-04-15T00:00:00Z'), new Date('2026-04-16T00:00:00Z'))
		).toHaveLength(0);
	});

	it('keeps wall-clock time across DST', () => {
		// 9am New York daily, spanning the March 8 2026 DST change
		const ev = {
			id: 'a',
			startsAt: new Date('2026-03-06T14:00:00Z'),
			endsAt: new Date('2026-03-06T15:00:00Z'),
			timezone: NY,
			rrule: 'FREQ=DAILY'
		};
		const occ = expand(ev, new Date('2026-03-06T00:00:00Z'), new Date('2026-03-11T00:00:00Z'));
		expect(occ.map((o) => o.start.toISOString())).toEqual([
			'2026-03-06T14:00:00.000Z',
			'2026-03-07T14:00:00.000Z',
			'2026-03-08T13:00:00.000Z',
			'2026-03-09T13:00:00.000Z',
			'2026-03-10T13:00:00.000Z'
		]);
	});

	it('applies exdates and overrides', () => {
		const ev = {
			id: 'a',
			startsAt: new Date('2026-04-13T13:00:00Z'),
			endsAt: new Date('2026-04-13T14:00:00Z'),
			timezone: NY,
			rrule: 'FREQ=DAILY;COUNT=4',
			exdates: [new Date('2026-04-14T13:00:00Z')]
		};
		const occ = expand(ev, new Date('2026-04-13T00:00:00Z'), new Date('2026-04-20T00:00:00Z'), [
			{
				originalStart: new Date('2026-04-15T13:00:00Z'),
				patch: { startsAt: '2026-04-15T18:00:00Z', endsAt: '2026-04-15T19:30:00Z', title: 'Moved' }
			},
			{ originalStart: new Date('2026-04-16T13:00:00Z'), patch: { cancelled: true } }
		]);
		expect(occ).toHaveLength(2);
		expect(occ[1]!.start.toISOString()).toBe('2026-04-15T18:00:00.000Z');
		expect(occ[1]!.patch?.title).toBe('Moved');
		expect(occ[1]!.originalStart.toISOString()).toBe('2026-04-15T13:00:00.000Z');
	});

	it('includes occurrences that started before the window but overlap it', () => {
		const ev = {
			id: 'a',
			startsAt: new Date('2026-04-13T22:00:00Z'),
			endsAt: new Date('2026-04-14T02:00:00Z'),
			timezone: 'UTC',
			rrule: 'FREQ=DAILY'
		};
		const occ = expand(ev, new Date('2026-04-14T00:00:00Z'), new Date('2026-04-14T01:00:00Z'));
		expect(occ).toHaveLength(1);
		expect(occ[0]!.start.toISOString()).toBe('2026-04-13T22:00:00.000Z');
	});
});

describe('rules', () => {
	it('nextStart skips exdates', () => {
		const ev = {
			id: 'a',
			startsAt: new Date('2026-04-13T13:00:00Z'),
			endsAt: new Date('2026-04-13T13:00:00Z'),
			timezone: NY,
			rrule: 'FREQ=DAILY',
			exdates: [new Date('2026-04-14T13:00:00Z')]
		};
		expect(nextStart(ev, new Date('2026-04-13T13:00:00Z'))?.toISOString()).toBe(
			'2026-04-15T13:00:00.000Z'
		);
	});

	it('presets round-trip', () => {
		const start = new Date('2026-04-15T13:00:00Z'); // Wednesday
		expect(presetRule('weekly', start, NY)).toBe('FREQ=WEEKLY;BYDAY=WE');
		expect(rulePreset(presetRule('biweekly', start, NY))).toBe('biweekly');
		expect(rulePreset('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')).toBe('weekdays');
		expect(rulePreset('FREQ=HOURLY')).toBe('custom');
	});

	it('truncateRule ends the series before a date', () => {
		const ev = {
			id: 'a',
			startsAt: new Date('2026-04-13T13:00:00Z'),
			endsAt: new Date('2026-04-13T14:00:00Z'),
			timezone: NY,
			rrule: 'FREQ=DAILY;COUNT=10'
		};
		const truncated = truncateRule(ev.rrule, new Date('2026-04-16T13:00:00Z'));
		const occ = expand(
			{ ...ev, rrule: truncated },
			new Date('2026-04-01T00:00:00Z'),
			new Date('2026-05-01T00:00:00Z')
		);
		expect(occ).toHaveLength(3);
	});

	it('truncateRule splits correctly east of UTC', () => {
		const tokyo = 'Asia/Tokyo';
		const ev = {
			id: 'b',
			startsAt: new Date('2026-04-13T01:00:00Z'), // 10:00 Tokyo
			endsAt: new Date('2026-04-13T02:00:00Z'),
			timezone: tokyo,
			rrule: 'FREQ=DAILY'
		};
		const truncated = truncateRule(ev.rrule, new Date('2026-04-16T01:00:00Z'));
		const occ = expand(
			{ ...ev, rrule: truncated },
			new Date('2026-04-01T00:00:00Z'),
			new Date('2026-05-01T00:00:00Z')
		);
		expect(occ.map((o) => o.start.toISOString())).toEqual([
			'2026-04-13T01:00:00.000Z',
			'2026-04-14T01:00:00.000Z',
			'2026-04-15T01:00:00.000Z'
		]);
	});

	it('UNTIL is a UTC instant (Google format)', () => {
		const ev = {
			id: 'c',
			startsAt: new Date('2026-04-13T14:00:00Z'), // 10:00 New York
			endsAt: new Date('2026-04-13T15:00:00Z'),
			timezone: NY,
			rrule: 'FREQ=DAILY;UNTIL=20260415T140000Z'
		};
		const occ = expand(ev, new Date('2026-04-01T00:00:00Z'), new Date('2026-05-01T00:00:00Z'));
		expect(occ).toHaveLength(3);
		expect(ruleUntil(ev.rrule)?.toISOString()).toBe('2026-04-15T14:00:00.000Z');
	});
});
