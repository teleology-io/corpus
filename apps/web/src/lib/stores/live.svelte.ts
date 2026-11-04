import { invalidate, refreshAll } from '$app/navigation';
import type { NotificationDTO } from '#lib/types.js';
import { toast } from './toast.svelte.js';

type LiveEvent =
	| { type: 'notification'; notification: Omit<NotificationDTO, 'readAt'> }
	| { type: 'notifications_read'; ids: string[] | null }
	| { type: 'integration_items'; provider: string; changes?: number }
	| { type: 'invalidate'; scope?: string };

class Live {
	unread = $state(0);
	latest = $state<NotificationDTO[]>([]);
	connected = $state(false);
	private source: EventSource | null = null;
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	/** `true` = everything; otherwise the dependency keys waiting to be invalidated. */
	private pending: true | Set<string> = new Set();
	private onVisible = () => {
		if (!document.hidden) this.flush();
	};

	start(initialUnread: number) {
		this.unread = initialUnread;
		if (this.source) return;
		document.addEventListener('visibilitychange', this.onVisible);
		this.source = new EventSource('/api/stream');
		this.source.onopen = () => (this.connected = true);
		this.source.onerror = () => (this.connected = false);
		this.source.onmessage = (e) => {
			try {
				this.handle(JSON.parse(e.data) as LiveEvent);
			} catch {
				/* ignore malformed */
			}
		};
	}

	stop() {
		this.source?.close();
		this.source = null;
		document.removeEventListener('visibilitychange', this.onVisible);
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
	}

	private handle(event: LiveEvent) {
		switch (event.type) {
			case 'notification':
				this.unread += 1;
				this.latest = [{ ...event.notification, readAt: null }, ...this.latest].slice(0, 50);
				toast(event.notification.title, {
					body: event.notification.body,
					href: event.notification.href
				});
				this.softRefresh();
				break;
			case 'notifications_read':
				if (event.ids === null) {
					this.unread = 0;
					this.latest = this.latest.map((n) => ({
						...n,
						readAt: n.readAt ?? new Date().toISOString()
					}));
				} else {
					const ids = new Set(event.ids);
					const newlyRead = this.latest.filter((n) => ids.has(n.id) && !n.readAt).length;
					this.unread = Math.max(0, this.unread - Math.max(newlyRead, 0));
					this.latest = this.latest.map((n) =>
						ids.has(n.id) ? { ...n, readAt: new Date().toISOString() } : n
					);
				}
				break;
			case 'integration_items':
				// Only loaders that read integration data re-run. A poll that changed nothing
				// still refreshes connection status (last polled / errors) on the pages showing it.
				this.softRefresh(event.changes === 0 ? 'app:integration-status' : 'app:integrations');
				break;
			case 'invalidate':
				this.softRefresh(event.scope === 'integrations' ? 'app:integrations' : undefined);
				break;
		}
	}

	/**
	 * Debounced reload of page data so dashboards stay live. With a `key`, only loaders that
	 * `depends()` on it re-run; without one, everything does. Deferred while the tab is hidden.
	 */
	softRefresh(key?: string) {
		if (key === undefined) this.pending = true;
		else if (this.pending !== true) this.pending.add(key);
		if (typeof document !== 'undefined' && document.hidden) return;
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => this.flush(), 400);
	}

	private flush() {
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = null;
		const pending = this.pending;
		this.pending = new Set();
		if (pending === true) void refreshAll();
		else for (const key of pending) void invalidate(key);
	}
}

export const live = new Live();
