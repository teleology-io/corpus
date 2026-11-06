import { invalidateAll } from '$app/navigation';
import { waitForModel } from '../notes/model-cache.js';
import {
	REWRITE_DOWNLOAD,
	rewriteModelComplete,
	rewriteSupported,
	startRewrite
} from '../notes/rewrite.js';
import { readRewritePrefs } from '#lib/stores/rewrite-prefs.js';
import type { TranscriptSegment } from '#lib/telescope.js';
import { buildTitleMessages, cleanTitle, MAX_TITLE_TOKENS } from './auto-title-prompt.js';

/** Null when the model can't run here. Never downloads it: that stays the background job's call. */
async function generateTitle(segments: TranscriptSegment[]) {
	const messages = buildTitleMessages(segments);
	if (!messages || !readRewritePrefs().enabled || !(await rewriteSupported())) return null;
	await waitForModel(REWRITE_DOWNLOAD.name);
	if (!(await rewriteModelComplete())) return null;
	return new Promise<string | null>((resolve, reject) => {
		let output = '';
		startRewrite(messages, MAX_TITLE_TOKENS, {
			ontoken: (text) => (output += text),
			ondone: () => resolve(cleanTitle(output) || null),
			onerror: (message) => reject(new Error(message))
		});
	});
}

/** Best effort: on any failure the recording keeps its current title. */
export async function autoTitleVideo(id: string, segments: TranscriptSegment[]) {
	try {
		const title = await generateTitle(segments);
		if (!title) return;
		const res = await fetch(`/api/telescope/${id}/auto-title`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ title })
		});
		if (res.ok && ((await res.json()) as { applied: boolean }).applied) await invalidateAll();
	} catch (e) {
		console.warn('Could not auto-title recording', e);
	}
}
