/**
 * When the standup sheet fetches evidence: once per opening, and only if there is no snapshot or
 * it expired. A failed fetch is not retried until the user asks (Refresh / Try again) or reopens.
 */
export function createEvidenceGate() {
	let armed = false;
	return {
		/** Call whenever `open` changes. True means: fetch now. */
		opened(open: boolean, expiresAt: string | null, now = Date.now()): boolean {
			if (!open) {
				armed = false;
				return false;
			}
			if (armed) return false;
			armed = true;
			return !expiresAt || Date.parse(expiresAt) <= now;
		}
	};
}
