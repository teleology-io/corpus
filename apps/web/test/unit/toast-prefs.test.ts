import { describe, expect, it } from 'vitest';
import {
	DEFAULT_TOAST_PREFS,
	parseToastPrefs,
	toastDuration
} from '../../src/lib/stores/toast-prefs.js';

describe('toast preferences', () => {
	it('falls back to defaults for missing or invalid values', () => {
		expect(parseToastPrefs(null)).toEqual(DEFAULT_TOAST_PREFS);
		expect(parseToastPrefs('not json')).toEqual(DEFAULT_TOAST_PREFS);
		expect(parseToastPrefs('{"sticky":"yes","seconds":7}')).toEqual(DEFAULT_TOAST_PREFS);
	});

	it('keeps saved values', () => {
		expect(parseToastPrefs('{"sticky":true,"seconds":30}')).toEqual({ sticky: true, seconds: 30 });
	});

	it('uses the chosen duration for every tone, with a floor for errors', () => {
		const prefs = { sticky: false, seconds: 3 };
		expect(toastDuration(prefs, 'info')).toBe(3000);
		expect(toastDuration(prefs, 'success')).toBe(3000);
		expect(toastDuration(prefs, 'error')).toBe(7000);
		expect(toastDuration({ sticky: false, seconds: 30 }, 'error')).toBe(30000);
	});

	it('has no duration when sticky', () => {
		expect(toastDuration({ sticky: true, seconds: 5 }, 'info')).toBeNull();
		expect(toastDuration({ sticky: true, seconds: 5 }, 'error')).toBeNull();
	});
});
