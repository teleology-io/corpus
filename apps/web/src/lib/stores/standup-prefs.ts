import type { ProviderPref } from '#lib/standup/model.js';

/**
 * Device-local standup choices. Whether Standup is on and its detail level are per user
 * (user_settings); which model to use depends on this device (WebGPU, downloaded model), so it lives here.
 */
export interface StandupDevicePrefs {
	provider: ProviderPref;
}

const PREFS_KEY = 'corpus-standup-device';
export const DEFAULT_STANDUP_DEVICE_PREFS: StandupDevicePrefs = { provider: 'auto' };
const PROVIDERS: ProviderPref[] = ['auto', 'liquid', 'hosted'];

export function parseStandupDevicePrefs(raw: string | null): StandupDevicePrefs {
	try {
		const p = JSON.parse(raw ?? '{}');
		return { provider: PROVIDERS.includes(p.provider) ? p.provider : 'auto' };
	} catch {
		return { ...DEFAULT_STANDUP_DEVICE_PREFS };
	}
}

export function readStandupDevicePrefs(): StandupDevicePrefs {
	try {
		return parseStandupDevicePrefs(localStorage.getItem(PREFS_KEY));
	} catch {
		return { ...DEFAULT_STANDUP_DEVICE_PREFS };
	}
}

export function saveStandupDevicePrefs(prefs: StandupDevicePrefs) {
	try {
		localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
	} catch {
		/* storage unavailable — the choice lasts until reload */
	}
}
