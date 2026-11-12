import {
	rewriteModelComplete,
	rewriteSupported,
	startRewrite
} from '../components/notes/rewrite.js';
import { readRewritePrefs } from '#lib/stores/rewrite-prefs.js';
import {
	buildCommitMessages,
	cleanCommitMessage,
	MAX_COMMIT_TOKENS,
	type UntrackedFile
} from './commit-message-prompt.js';

/** Past this the user is better off typing the message themselves. */
const GENERATE_TIMEOUT_MS = 30_000;

/**
 * True only when the on-device model can write a message right now: no WebGPU, the feature off,
 * or the model not fully on disk (including mid-download) all mean the user types it instead.
 */
export async function commitModelReady() {
	try {
		return (
			readRewritePrefs().enabled && (await rewriteSupported()) && (await rewriteModelComplete())
		);
	} catch {
		return false;
	}
}

/** Null when the model can't run, fails, stalls, is cancelled, or gives nothing usable. */
export async function generateCommitMessage(
	status: string,
	diff: string,
	untracked: UntrackedFile[] = [],
	signal?: AbortSignal
) {
	const messages = buildCommitMessages({ status, diff, untracked });
	if (!messages || signal?.aborted || !(await commitModelReady())) return null;
	let run: { cancel: () => void } | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await new Promise<string | null>((resolve, reject) => {
			let output = '';
			timer = setTimeout(() => reject(new Error('Timed out')), GENERATE_TIMEOUT_MS);
			signal?.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
			run = startRewrite(messages, MAX_COMMIT_TOKENS, {
				ontoken: (text) => (output += text),
				ondone: () => resolve(cleanCommitMessage(output) || null),
				onerror: (message) => reject(new Error(message))
			});
		});
	} catch (e) {
		run?.cancel();
		console.warn('Could not write a commit message', e);
		return null;
	} finally {
		clearTimeout(timer);
	}
}
