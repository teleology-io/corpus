/** Small fetch wrapper for the JSON API. Throws Error(message) on non-2xx. */
export async function api<T = unknown>(
	path: string,
	init: { method?: string; body?: unknown } = {}
): Promise<T> {
	const res = await fetch(path, {
		method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
		headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
		body: init.body !== undefined ? JSON.stringify(init.body) : undefined
	});
	if (!res.ok) {
		let message = res.statusText;
		try {
			const data = await res.json();
			message = data.message ?? message;
		} catch {
			/* not json */
		}
		throw new Error(message || `Request failed (${res.status})`);
	}
	if (res.status === 204 || res.status === 202) return undefined as T;
	return res.json() as Promise<T>;
}
