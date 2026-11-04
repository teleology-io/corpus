export interface RewritePrefs {
	/** Download the model and show the rewrite action in notes, on this device. */
	enabled: boolean;
}

const PREFS_KEY = 'corpus-rewrite-prefs';

export const DEFAULT_REWRITE_PREFS: RewritePrefs = { enabled: true };

export function parseRewritePrefs(raw: string | null): RewritePrefs {
	try {
		const p = JSON.parse(raw ?? '{}');
		return { enabled: p.enabled !== false };
	} catch {
		return { ...DEFAULT_REWRITE_PREFS };
	}
}

export function readRewritePrefs(): RewritePrefs {
	try {
		return parseRewritePrefs(localStorage.getItem(PREFS_KEY));
	} catch {
		return { ...DEFAULT_REWRITE_PREFS };
	}
}

export function saveRewritePrefs(prefs: RewritePrefs) {
	try {
		localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
	} catch {
		/* storage unavailable — the choice lasts until reload */
	}
}
