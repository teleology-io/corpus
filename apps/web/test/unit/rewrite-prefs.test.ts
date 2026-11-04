import { describe, expect, it } from 'vitest';
import { DEFAULT_REWRITE_PREFS, parseRewritePrefs } from '../../src/lib/stores/rewrite-prefs.js';

describe('rewrite preferences', () => {
	it('is enabled by default', () => {
		expect(parseRewritePrefs(null)).toEqual(DEFAULT_REWRITE_PREFS);
		expect(parseRewritePrefs('not json')).toEqual(DEFAULT_REWRITE_PREFS);
		expect(DEFAULT_REWRITE_PREFS).toEqual({ enabled: true });
	});

	it('keeps a saved opt-out', () => {
		expect(parseRewritePrefs('{"enabled":false}')).toEqual({ enabled: false });
	});
});
