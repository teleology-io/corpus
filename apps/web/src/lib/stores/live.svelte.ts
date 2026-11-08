import { invalidate, refreshAll } from '$app/navigation';
import type { NotificationDTO } from '#lib/types.js';
import { toast } from './toast.svelte.js';

type LiveEvent =
	| { type: 'notification'; notification: Omit<NotificationDTO, 'readAt'> }
	| { type: 'notifications_read'; ids: string[] | null }
	| { type: 'integration_items'; provider: string; changes?: number }
	| { type: 'invalidate'; scope?: string };

type RelayMessage =
	{ kind: 'event'; event: LiveEvent } | { kind: 'status'; connected: boolean } | { kind: 'hello' };

class Live {
	unread = $state(0);
	latest = $state<NotificationDTO[]>([]);
	connected = $state(false);
	private source: EventSource | null = null;
	private channel: BroadcastChannel | null = null;
	private releaseLeader: (() => void) | null = null;
	private leader = false;
	private started = false;
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	/** `true` = everything; otherwise the dependency keys waiting to be invalidated. */
	private pending: true | Set<string> = new Set();
	private onVisible = () => {
		if (!document.hidden) this.flush();
	};

	/**
	 * One SSE connection per browser, not per tab: browsers cap HTTP/1.1 connections per origin
	 * (~6), so a stream per tab starves page and API requests once several tabs are open. Tabs
	 * elect a leader with a Web Lock; the leader holds the EventSource and relays every event
	 * over a BroadcastChannel. When the leader tab closes, its lock is released and the next
	 * tab takes over. Every tab still handles every event itself (toasts, counts, refreshes).
	 */
	start(initialUnread: number, userId: string) {
		this.unread = initialUnread;
		if (this.started) return;
		this.started = true;
		document.addEventListener('visibilitychange', this.onVisible);
		const name = `corpus-live:${userId}`;
		if (typeof BroadcastChannel === 'undefined' || !navigator.locks) {
			this.connect(null);
			return;
		}
		const channel = (this.channel = new BroadcastChannel(name));
		channel.onmessage = ({ data }: MessageEvent<RelayMessage>) => {
			if (data.kind === 'event') this.handle(data.event);
			else if (data.kind === 'status') this.connected = data.connected;
			else if (data.kind === 'hello' && this.leader)
				this.relay({ kind: 'status', connected: this.connected });
		};
		// Followers learn the current connection state from the leader.
		channel.postMessage({ kind: 'hello' } satisfies RelayMessage);
		void navigator.locks.request(
			name,
			() =>
				new Promise<void>((release) => {
					if (!this.started) return release();
					this.leader = true;
					this.releaseLeader = release;
					this.connect(channel);
				})
		);
	}

	private relay(message: RelayMessage) {
		try {
			this.channel?.postMessage(message);
		} catch {
			/* channel closed */
		}
	}

	private connect(channel: BroadcastChannel | null) {
		const setConnected = (connected: boolean) => {
			this.connected = connected;
			if (channel) this.relay({ kind: 'status', connected });
		};
		this.source = new EventSource('/api/stream');
		this.source.onopen = () => setConnected(true);
		this.source.onerror = () => setConnected(false);
		this.source.onmessage = (e) => {
			let event: LiveEvent;
			try {
				event = JSON.parse(e.data) as LiveEvent;
			} catch {
				return; /* ignore malformed */
			}
			this.handle(event);
			if (channel) this.relay({ kind: 'event', event });
		};
	}

	stop() {
		this.started = false;
		this.source?.close();
		this.source = null;
		this.leader = false;
		this.releaseLeader?.();
		this.releaseLeader = null;
		this.channel?.close();
		this.channel = null;
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
				// New Slack activity can light up the nav dot (cheap: one cached query).
				if (event.provider === 'slack' && event.changes !== 0) this.softRefresh('app:slack-unread');
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
