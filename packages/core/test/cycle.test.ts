import { describe, expect, it } from 'vitest';
import { describeCycle, doseOccurrences, phaseOn, phaseSegments } from '../src/cycle';

const sixThree = {
	startDate: '2026-01-05',
	onDays: 42,
	offDays: 21,
	repeatCount: null,
	doseTimes: ['08:00', '20:00'],
	timezone: 'America/Chicago'
};

describe('phaseOn', () => {
	it('handles before start', () => {
		expect(phaseOn(sixThree, '2026-01-01')).toEqual({
			status: 'not_started',
			startsOn: '2026-01-05',
			daysUntil: 4
		});
	});
	it('first and last on day', () => {
		expect(phaseOn(sixThree, '2026-01-05')).toMatchObject({
			status: 'on',
			dayOfPhase: 1,
			cycleNumber: 1,
			phaseEnd: '2026-02-15'
		});
		expect(phaseOn(sixThree, '2026-02-15')).toMatchObject({ status: 'on', dayOfPhase: 42 });
	});
	it('off phase boundaries', () => {
		expect(phaseOn(sixThree, '2026-02-16')).toMatchObject({
			status: 'off',
			dayOfPhase: 1,
			phaseLength: 21,
			nextPhaseStart: '2026-03-09'
		});
		expect(phaseOn(sixThree, '2026-03-08')).toMatchObject({ status: 'off', dayOfPhase: 21 });
		expect(phaseOn(sixThree, '2026-03-09')).toMatchObject({
			status: 'on',
			cycleNumber: 2,
			dayOfPhase: 1
		});
	});
	it('finishes after repeatCount cycles', () => {
		const c = { ...sixThree, repeatCount: 2 };
		expect(phaseOn(c, '2026-05-10')).toMatchObject({
			status: 'off',
			cycleNumber: 2,
			nextPhaseStart: null
		});
		expect(phaseOn(c, '2026-05-11')).toEqual({ status: 'finished', endedOn: '2026-05-10' });
	});
});

describe('doseOccurrences', () => {
	it('emits doses on on-days only, in local time', () => {
		const doses = doseOccurrences(
			sixThree,
			new Date('2026-02-15T00:00:00Z'),
			new Date('2026-02-18T00:00:00Z')
		);
		// Feb 14 20:00, Feb 15 08:00 & 20:00 CST (Feb 15 = last on day)
		expect(doses.map((d) => d.toISOString())).toEqual([
			'2026-02-15T02:00:00.000Z',
			'2026-02-15T14:00:00.000Z',
			'2026-02-16T02:00:00.000Z'
		]);
	});
	it('stops after pause', () => {
		const doses = doseOccurrences(
			{ ...sixThree, pausedAt: new Date('2026-01-06T00:00:00Z') },
			new Date('2026-01-05T00:00:00Z'),
			new Date('2026-01-08T00:00:00Z')
		);
		expect(doses).toHaveLength(1);
	});
});

describe('helpers', () => {
	it('segments and description', () => {
		expect(phaseSegments(sixThree, '2026-02-10', '2026-03-12')).toEqual([
			{ status: 'on', start: '2026-02-10', end: '2026-02-15', cycleNumber: 1 },
			{ status: 'off', start: '2026-02-16', end: '2026-03-08', cycleNumber: 1 },
			{ status: 'on', start: '2026-03-09', end: '2026-03-12', cycleNumber: 2 }
		]);
		expect(describeCycle(sixThree)).toBe('6w on / 3w off');
		expect(describeCycle({ onDays: 5, offDays: 2 })).toBe('5d on / 2d off');
	});
});
