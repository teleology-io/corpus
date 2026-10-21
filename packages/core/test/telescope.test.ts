import { describe, expect, it } from 'vitest';
import { parseRange, toVtt, vttTime } from '../src/telescope';

describe('parseRange', () => {
	it('returns null without a header or for unsupported forms', () => {
		expect(parseRange(null, 100)).toBeNull();
		expect(parseRange('bytes=0-1,5-9', 100)).toBeNull();
		expect(parseRange('items=0-1', 100)).toBeNull();
		expect(parseRange('bytes=-', 100)).toBeNull();
	});

	it('parses bounded, open-ended and suffix ranges', () => {
		expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
		expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
		expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
		expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
	});

	it('clamps the end to the object size', () => {
		expect(parseRange('bytes=50-1000', 100)).toEqual({ start: 50, end: 99 });
	});

	it('flags ranges outside the object', () => {
		expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
		expect(parseRange('bytes=9-3', 100)).toBe('unsatisfiable');
		expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
	});
});

describe('toVtt', () => {
	it('formats timestamps', () => {
		expect(vttTime(0)).toBe('00:00:00.000');
		expect(vttTime(3723.456)).toBe('01:02:03.456');
	});

	it('builds numbered cues, skipping empty segments', () => {
		expect(
			toVtt([
				{ start: 0, end: 1.5, text: 'hello there' },
				{ start: 2, end: 2, text: '   ' },
				{ start: 3, end: 3.1, text: 'a --> b' }
			])
		).toBe(
			'WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.500\nhello there\n\n2\n00:00:03.000 --> 00:00:03.500\na → b\n'
		);
	});
});
