import { refreshAll } from '$app/navigation';
import type { NotificationDTO } from '#lib/types.js';
import { toast } from './toast.svelte.js';

type LiveEvent =
	| { type: 'notification'; notification: Omit<NotificationDTO, 'readAt'> }
	| { type: 'notifications_read'; ids: string[] | null }
	| { type: 'integration_items'; provider: string }
	| { type: 'invalidate'; scope?: string };

class Live {
	unread = $state(0);
	latest = $state<NotificationDTO[]>([]);
	connected = $state(false);
	private source: EventSource | null = null;
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;

	start(initialUnread: number) {
		this.unread = initialUnread;
		if (this.source) return;
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
			case 'invalidate':
				this.softRefresh();
				break;
		}
	}

	/** Debounced reload of page data so dashboards stay live. */
	softRefresh() {
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => void refreshAll(), 400);
	}
}

export const live = new Live();
