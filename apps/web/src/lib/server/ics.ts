import { toWallClock } from '@corpus/core';

/** Minimal RFC 5545 writer — enough for export + subscribable feeds (supports RRULE/EXDATE). */

export interface IcsEvent {
	uid: string;
	title: string;
	description?: string | null;
	location?: string | null;
	start: Date;
	end: Date;
	allDay: boolean;
	rrule?: string | null;
	exdates?: Date[];
	timezone?: string;
	updatedAt?: Date;
}

const stamp = (d: Date) =>
	d
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d{3}/, '');
const local = (d: Date, tz: string) => stamp(toWallClock(d, tz)).replace(/Z$/, '');
const dateOnly = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
const escape = (s: string) =>
	s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Fold lines at 75 octets as required by the spec. */
function fold(line: string) {
	const out: string[] = [];
	let rest = line;
	while (rest.length > 75) {
		out.push(rest.slice(0, 75));
		rest = ' ' + rest.slice(75);
	}
	out.push(rest);
	return out.join('\r\n');
}

export function toIcs(name: string, events: IcsEvent[]): string {
	const lines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//Corpus//Calendar//EN',
		'CALSCALE:GREGORIAN',
		`X-WR-CALNAME:${escape(name)}`
	];
	for (const e of events) {
		lines.push(
			'BEGIN:VEVENT',
			`UID:${e.uid}@corpus`,
			`DTSTAMP:${stamp(e.updatedAt ?? new Date())}`
		);
		if (e.allDay) {
			lines.push(`DTSTART;VALUE=DATE:${dateOnly(e.start)}`, `DTEND;VALUE=DATE:${dateOnly(e.end)}`);
		} else if (e.rrule && e.timezone && e.timezone !== 'UTC') {
			// Recurring series keep wall-clock time across DST in subscribing clients.
			lines.push(
				`DTSTART;TZID=${e.timezone}:${local(e.start, e.timezone)}`,
				`DTEND;TZID=${e.timezone}:${local(e.end, e.timezone)}`
			);
		} else {
			lines.push(`DTSTART:${stamp(e.start)}`, `DTEND:${stamp(e.end)}`);
		}
		lines.push(`SUMMARY:${escape(e.title)}`);
		if (e.description) lines.push(`DESCRIPTION:${escape(e.description)}`);
		if (e.location) lines.push(`LOCATION:${escape(e.location)}`);
		if (e.rrule) lines.push(`RRULE:${e.rrule}`);
		for (const x of e.exdates ?? []) {
			lines.push(
				e.timezone && e.timezone !== 'UTC' && !e.allDay
					? `EXDATE;TZID=${e.timezone}:${local(x, e.timezone)}`
					: `EXDATE:${stamp(x)}`
			);
		}
		lines.push('END:VEVENT');
	}
	lines.push('END:VCALENDAR');
	return lines.map(fold).join('\r\n') + '\r\n';
}
