/**
 * App-wide action feedback. Rendered by <Toaster /> in the root layout, and by a second
 * <Toaster inDrawer /> inside each open drawer: a modal <dialog> sits in the browser's top layer
 * and makes everything outside it inert, so a page-level toast would be hidden behind it.
 */
export type Toast = { id: number; text: string; tone: 'ok' | 'error' };

export const toasts = $state<Toast[]>([]);

/** How many drawers are open; decides which <Toaster> renders. */
export const layers = $state({ drawers: 0 });

let next = 0;
export function toast(text: string, tone: Toast['tone'] = 'ok') {
	const id = ++next;
	toasts.push({ id, text, tone });
	setTimeout(() => dismiss(id), tone === 'error' ? 8000 : 4500);
}

export function dismiss(id: number) {
	const i = toasts.findIndex((t) => t.id === id);
	if (i >= 0) toasts.splice(i, 1);
}
