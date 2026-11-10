import { describe, expect, it } from 'vitest';
import { expand } from '../src/recurrence';
import { icalPollInterval, parseDuration, parseIcal, parseIcalUrl } from '../src/integrations';

const NY = 'America/New_York';

const FEED = [
	'BEGIN:VCALENDAR',
	'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
	'VERSION:2.0',
	'X-WR-CALNAME:Work',
	'X-WR-TIMEZONE:America/New_York',
	'BEGIN:VTIMEZONE',
	'TZID:America/New_York',
	'END:VTIMEZONE',
	'BEGIN:VEVENT',
	'DTSTART;TZID=America/New_York:20260413T100000',
	'DTEND;TZID=America/New_York:20260413T101500',
	'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20260422T140000Z',
	'EXDATE;TZID=America/New_York:20260415T100000',
	'DTSTAMP:20261103T120000Z',
	'ORGANIZER;CN=Ann:mailto:ann@x.com',
	'UID:abc@google.com',
	'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Me@X.com;X-NUM-GUESTS=0:mailto:me@x.com',
	'ATTENDEE;CUTYPE=RESOURCE;CN=Room 1:mailto:room@resource.calendar.google.com',
	'SUMMARY:Stand\\, up',
	'DESCRIPTION:Line one\\nLine two that is long enough to be folded by the generat',
	' or here',
	'STATUS:CONFIRMED',
	'BEGIN:VALARM',
	'ACTION:DISPLAY',
	'TRIGGER:-P0DT0H15M0S',
	'END:VALARM',
	'END:VEVENT',
	'BEGIN:VEVENT',
	'DTSTART;TZID=America/New_York:20260420T110000',
	'DTEND;TZID=America/New_York:20260420T111500',
	'RECURRENCE-ID;TZID=America/New_York:20260420T100000',
	'UID:abc@google.com',
	'SUMMARY:Stand up (moved)',
	'END:VEVENT',
	'BEGIN:VEVENT',
	'DTSTART;VALUE=DATE:20260501',
	'DTEND;VALUE=DATE:20260502',
	'UID:allday@google.com',
	'SUMMARY:Holiday',
	'END:VEVENT',
	'END:VCALENDAR',
	''
].join('\r\n');

describe('ical feed parsing', () => {
	const cal = parseIcal(FEED, 'UTC');

	it('reads calendar metadata', () => {
		expect(cal.name).toBe('Work');
		expect(cal.timezone).toBe(NY);
		expect(cal.events).toHaveLength(3);
	});

	it('maps a recurring master and expands it', () => {
		const m = cal.events[0]!;
		expect(m.uid).toBe('abc@google.com');
		expect(m.recurrenceId).toBeNull();
		expect(m.fields.title).toBe('Stand, up');
		expect(m.fields.description).toBe(
			'Line one\nLine two that is long enough to be folded by the generator here'
		);
		expect(m.fields.startsAt.toISOString()).toBe('2026-04-13T14:00:00.000Z');
		expect(m.fields.endsAt.toISOString()).toBe('2026-04-13T14:15:00.000Z');
		expect(m.fields.timezone).toBe(NY);
		expect(m.fields.reminders).toEqual([15]);
		expect(m.fields.attendees).toEqual([{ email: 'me@x.com', name: null, rsvp: 'accepted' }]);
		expect(m.fields.meta.organizer).toBe('Ann');
		const occ = expand(
			{ id: 'e', ...m.fields },
			new Date('2026-04-01T00:00:00Z'),
			new Date('2026-05-01T00:00:00Z')
		).map((o) => o.start.toISOString());
		// Mon 13, (Wed 15 excluded), Mon 20, Wed 22
		expect(occ).toEqual([
			'2026-04-13T14:00:00.000Z',
			'2026-04-20T14:00:00.000Z',
			'2026-04-22T14:00:00.000Z'
		]);
	});

	it('maps an edited instance', () => {
		const i = cal.events[1]!;
		expect(i.recurrenceId?.toISOString()).toBe('2026-04-20T14:00:00.000Z');
		expect(i.fields.startsAt.toISOString()).toBe('2026-04-20T15:00:00.000Z');
	});

	it('maps all-day events in the calendar zone', () => {
		const e = cal.events[2]!;
		expect(e.fields.allDay).toBe(true);
		expect(e.fields.startsAt.toISOString()).toBe('2026-05-01T04:00:00.000Z');
		expect(e.fields.reminders).toEqual([]);
	});

	it('fingerprints ignore DTSTAMP', () => {
		const again = parseIcal(
			FEED.replace('DTSTAMP:20261103T120000Z', 'DTSTAMP:20261104T000000Z'),
			'UTC'
		);
		expect(again.events[0]!.hash).toBe(cal.events[0]!.hash);
		const edited = parseIcal(FEED.replace('SUMMARY:Holiday', 'SUMMARY:Day off'), 'UTC');
		expect(edited.events[2]!.hash).not.toBe(cal.events[2]!.hash);
	});
});

describe('ical helpers', () => {
	it('parses durations', () => {
		expect(parseDuration('-PT15M')).toBe(-15);
		expect(parseDuration('-P1D')).toBe(-1440);
		expect(parseDuration('P1DT2H')).toBe(1560);
		expect(parseDuration('junk')).toBeNull();
	});

	it('validates Google secret and public addresses', () => {
		const ok =
			'https://calendar.google.com/calendar/ical/me%40gmail.com/private-0123abcd/basic.ics';
		expect(parseIcalUrl(ok)).toBe(ok);
		expect(parseIcalUrl(ok.replace('https://', 'webcal://'))).toBe(ok);
		expect(() => parseIcalUrl('https://evil.example/calendar/ical/a/b/basic.ics')).toThrow();
		expect(() => parseIcalUrl('http://calendar.google.com/calendar/ical/a/b/basic.ics')).toThrow();
		const pub =
			'https://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics';
		expect(parseIcalUrl(pub)).toBe(pub);
		const id = 'en.usa#holiday@group.v.calendar.google.com';
		expect(
			parseIcalUrl(`https://calendar.google.com/calendar/embed?src=${encodeURIComponent(id)}`)
		).toBe(pub);
		const cid = Buffer.from(id).toString('base64');
		expect(parseIcalUrl(`https://calendar.google.com/calendar/u/0?cid=${cid}`)).toBe(pub);
		expect(() => parseIcalUrl('https://calendar.google.com/calendar/u/0?cid=junk')).toThrow();
	});

	it('polls every 5–15 minutes', () => {
		expect(icalPollInterval(() => 0)).toBe(300);
		expect(icalPollInterval(() => 1)).toBe(900);
	});
});
