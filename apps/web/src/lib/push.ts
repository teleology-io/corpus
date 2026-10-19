import { api } from './api.js';

function urlBase64ToUint8Array(base64: string) {
	const padding = '='.repeat((4 - (base64.length % 4)) % 4);
	const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
	return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export const pushSupported = () =>
	typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;

export async function registration() {
	return (
		(await navigator.serviceWorker.getRegistration('/')) ??
		navigator.serviceWorker.register('/sw.js', { scope: '/' })
	);
}

export async function currentSubscription() {
	if (!pushSupported()) return null;
	return (await registration()).pushManager.getSubscription();
}

/** Ask permission, subscribe this browser and register it with the server. */
export async function enablePush(vapidKey: string) {
	const permission = await Notification.requestPermission();
	if (permission !== 'granted') throw new Error('Notifications are blocked in this browser');
	const reg = await registration();
	await navigator.serviceWorker.ready;
	const sub =
		(await reg.pushManager.getSubscription()) ??
		(await reg.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: urlBase64ToUint8Array(vapidKey)
		}));
	await api('/api/push', { body: sub.toJSON() });
	return sub;
}

export async function disablePush() {
	const sub = await currentSubscription();
	if (!sub) return;
	await api('/api/push', { method: 'DELETE', body: { endpoint: sub.endpoint } });
	await sub.unsubscribe();
}
