// Corpus service worker: web push + notification clicks.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
	let data;
	try {
		data = event.data ? event.data.json() : {};
	} catch {
		data = { title: event.data?.text() };
	}
	const title = data.title || 'Corpus';
	event.waitUntil(
		self.registration.showNotification(title, {
			body: data.body || undefined,
			icon: '/favicon.svg',
			badge: '/favicon.svg',
			tag: data.tag || undefined,
			data: { href: data.href || '/dashboard' }
		})
	);
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const href = event.notification.data?.href || '/dashboard';
	const url = new URL(href, self.location.origin).href;
	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
			for (const client of windows) {
				if (new URL(client.url).origin === self.location.origin) {
					await client.focus();
					if (url.startsWith(self.location.origin)) client.navigate(url);
					return;
				}
			}
			await self.clients.openWindow(url);
		})()
	);
});
