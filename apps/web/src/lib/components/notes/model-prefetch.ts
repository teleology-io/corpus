// Fetches every AI model in the background after the app loads, so features are ready on first
// use. Imported lazily from the app layout to keep speech code out of its bundle.
import { ASR_DOWNLOAD } from './dictation.js';
import { REWRITE_DOWNLOAD, rewriteSupported } from './rewrite.js';
import { downloadModel } from './model-cache.js';
import { readRewritePrefs } from '#lib/stores/rewrite-prefs.js';

interface NetworkInformation {
	saveData?: boolean;
	type?: string;
}

function onMeteredNetwork() {
	const { connection } = navigator as unknown as { connection?: NetworkInformation };
	return !!connection && (connection.saveData === true || connection.type === 'cellular');
}

export async function prefetchModels() {
	if (onMeteredNetwork()) return;
	// Smallest first, so one feature is ready sooner.
	await downloadModel(ASR_DOWNLOAD);
	if (readRewritePrefs().enabled && (await rewriteSupported()))
		await downloadModel(REWRITE_DOWNLOAD);
}
