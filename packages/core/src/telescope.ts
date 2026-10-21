/** Pure helpers for Telescope video serving and captions. */

/**
 * Upload part size. Every part but the last is exactly this size: R2 requires equal-sized
 * parts (S3 minimum is 5 MiB).
 */
export const PART_SIZE = 8 * 1024 * 1024;

export interface Segment {
	start: number;
	end: number;
	text: string;
}

/**
 * Parses a single-range `Range: bytes=…` header against an object of `size` bytes.
 * Returns inclusive [start, end], null when absent/unsupported (serve the whole object),
 * or 'unsatisfiable' when the range lies outside the object (416).
 */
export function parseRange(
	header: string | null,
	size: number
): { start: number; end: number } | null | 'unsatisfiable' {
	if (!header) return null;
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!m) return null;
	const [, a, b] = m;
	if (a === '' && b === '') return null;
	let start: number;
	let end: number;
	if (a === '') {
		// Suffix range: the last N bytes.
		const n = Number(b);
		if (n === 0) return 'unsatisfiable';
		start = Math.max(0, size - n);
		end = size - 1;
	} else {
		start = Number(a);
		end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
	}
	if (start >= size || start > end) return 'unsatisfiable';
	return { start, end };
}

/** `HH:MM:SS.mmm` as WebVTT wants it. */
export function vttTime(seconds: number) {
	const ms = Math.max(0, Math.round(seconds * 1000));
	const h = Math.floor(ms / 3_600_000);
	const m = Math.floor((ms % 3_600_000) / 60_000);
	const s = Math.floor((ms % 60_000) / 1000);
	const pad = (n: number, w = 2) => String(n).padStart(w, '0');
	return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
}

/** WebVTT captions from transcript segments (cue text can't contain "-->" or blank lines). */
export function toVtt(segments: Segment[]) {
	const cues = segments
		.filter((s) => s.text.trim())
		.map((s, i) => {
			const end = Math.max(s.end, s.start + 0.5);
			const text = s.text
				.replace(/-->/g, '→')
				.replace(/\n\s*\n/g, '\n')
				.trim();
			return `${i + 1}\n${vttTime(s.start)} --> ${vttTime(end)}\n${text}`;
		});
	return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}
