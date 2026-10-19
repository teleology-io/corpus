export interface Toast {
	id: number;
	title: string;
	body?: string | null;
	href?: string | null;
	tone: 'info' | 'success' | 'error';
}

let next = 1;
export const toasts = $state<Toast[]>([]);

export function toast(title: string, opts: Partial<Omit<Toast, 'id' | 'title'>> = {}) {
	const t: Toast = {
		id: next++,
		title,
		tone: opts.tone ?? 'info',
		body: opts.body,
		href: opts.href
	};
	toasts.push(t);
	setTimeout(() => dismiss(t.id), opts.tone === 'error' ? 7000 : 5000);
}

export function dismiss(id: number) {
	const i = toasts.findIndex((t) => t.id === id);
	if (i >= 0) toasts.splice(i, 1);
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
