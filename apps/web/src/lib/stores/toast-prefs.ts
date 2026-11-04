export interface ToastPrefs {
	/** Keep every toast on screen until it's dismissed by hand. */
	sticky: boolean;
	/** Time on screen when not sticky. */
	seconds: number;
}

export const TOAST_SECONDS = [3, 5, 10, 15, 30, 60];
export const DEFAULT_TOAST_PREFS: ToastPrefs = { sticky: false, seconds: 5 };

/** Errors tend to carry more to read, so they never get less than this. */
const MIN_ERROR_MS = 7000;

export function parseToastPrefs(raw: string | null): ToastPrefs {
	try {
		const p = JSON.parse(raw ?? '{}');
		return {
			sticky: p.sticky === true,
			seconds: TOAST_SECONDS.includes(p.seconds) ? p.seconds : DEFAULT_TOAST_PREFS.seconds
		};
	} catch {
		return { ...DEFAULT_TOAST_PREFS };
	}
}

/** Milliseconds a toast stays up, or null when it stays until dismissed. */
export function toastDuration(prefs: ToastPrefs, tone: 'info' | 'success' | 'error') {
	if (prefs.sticky) return null;
	const ms = prefs.seconds * 1000;
	return tone === 'error' ? Math.max(ms, MIN_ERROR_MS) : ms;
}
