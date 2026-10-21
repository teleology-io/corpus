/** Client-safe Telescope types and formatting helpers. */

export interface ViewCounts {
	total: number;
	authed: number;
	anon: number;
}

export interface VideoSummary {
	id: string;
	title: string;
	status: 'uploading' | 'ready' | 'failed';
	durationMs: number;
	bytes: number;
	width: number | null;
	height: number | null;
	visibility: 'private' | 'link';
	/** Only present while the link is switched on */
	linkToken: string | null;
	hasThumb: boolean;
	transcriptStatus: 'pending' | 'done' | 'failed';
	createdAt: string;
	views: ViewCounts;
}

export interface VideoViewer {
	name: string;
	image: string | null;
	email: string;
	watchedMs: number;
	firstSeenAt: string;
	lastSeenAt: string;
}

export interface TranscriptSegment {
	start: number;
	end: number;
	text: string;
}

/** 0:07, 4:32, 1:02:03 */
export function fmtDuration(ms: number) {
	const total = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = String(total % 60).padStart(2, '0');
	return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function plural(n: number, word: string) {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}
