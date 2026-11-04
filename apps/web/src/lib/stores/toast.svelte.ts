import {
	DEFAULT_TOAST_PREFS,
	parseToastPrefs,
	toastDuration,
	type ToastPrefs
} from './toast-prefs.js';

export interface Toast {
	id: number;
	title: string;
	body?: string | null;
	href?: string | null;
	tone: 'info' | 'success' | 'error';
}

const PREFS_KEY = 'corpus-toast-prefs';

let next = 1;
export const toasts = $state<Toast[]>([]);
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- timer handles, never rendered
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export function readToastPrefs(): ToastPrefs {
	try {
		return parseToastPrefs(localStorage.getItem(PREFS_KEY));
	} catch {
		return { ...DEFAULT_TOAST_PREFS };
	}
}

/** Saves for this device and applies to the toasts already on screen. */
export function saveToastPrefs(prefs: ToastPrefs) {
	try {
		localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
	} catch {
		/* storage unavailable — still applies to what's on screen */
	}
	for (const t of toasts) schedule(t, prefs);
}

function schedule(t: Toast, prefs: ToastPrefs) {
	clearTimeout(timers.get(t.id));
	timers.delete(t.id);
	const ms = toastDuration(prefs, t.tone);
	if (ms !== null)
		timers.set(
			t.id,
			setTimeout(() => dismiss(t.id), ms)
		);
}

export function toast(title: string, opts: Partial<Omit<Toast, 'id' | 'title'>> = {}) {
	const t: Toast = {
		id: next++,
		title,
		tone: opts.tone ?? 'info',
		body: opts.body,
		href: opts.href
	};
	toasts.push(t);
	schedule(t, readToastPrefs());
}

export function dismiss(id: number) {
	clearTimeout(timers.get(id));
	timers.delete(id);
	const i = toasts.findIndex((t) => t.id === id);
	if (i >= 0) toasts.splice(i, 1);
}

export function dismissAll() {
	for (const t of [...toasts]) dismiss(t.id);
}

/** Run an async action, toast on failure. Returns undefined on error. */
export async function attempt<T>(
	fn: () => Promise<T>,
	errorTitle = 'Something went wrong'
): Promise<T | undefined> {
	try {
		return await fn();
	} catch (e) {
		toast(errorTitle, { tone: 'error', body: (e as Error).message });
		return undefined;
	}
}
