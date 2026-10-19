import { describe, expect, it } from 'vitest';
import { expand } from '../src/recurrence';
import {
	fromGoogle,
	instanceId,
	mrkdwnToText,
	parseExdates,
	parseMrkdwn,
	parseSlackLink,
	toGoogle
} from '../src/integrations';

const NY = 'America/New_York';

describe('google calendar mapping', () => {
	it('maps a timed recurring event and expands it', () => {
		const f = fromGoogle(
			{
				id: 'g1',
				summary: 'Standup',
				start: { dateTime: '2026-04-13T10:00:00-04:00', timeZone: NY },
				end: { dateTime: '2026-04-13T10:15:00-04:00', timeZone: NY },
				recurrence: [
					'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20260422T140000Z',
					'EXDATE;TZID=America/New_York:20260415T100000'
				],
				reminders: { useDefault: true },
				organizer: { email: 'a@x.com', self: false },
				attendees: [{ email: 'Me@X.com', self: true, responseStatus: 'accepted' }]
			},
			'UTC',
			[10]
		);
		expect(f.timezone).toBe(NY);
		expect(f.rrule).toBe('FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20260422T140000Z');
		expect(f.exdates.map((d) => d.toISOString())).toEqual(['2026-04-15T14:00:00.000Z']);
		expect(f.reminders).toEqual([10]);
		expect(f.attendees).toEqual([{ email: 'me@x.com', name: null, rsvp: 'accepted' }]);
		expect(f.meta.organizerSelf).toBe(false);
		const occ = expand(
			{ id: 'x', ...f },
			new Date('2026-04-01T00:00:00Z'),
			new Date('2026-05-01T00:00:00Z')
		);
		// Mon 13, (Wed 15 excluded), Mon 20, Wed 22
		expect(occ.map((o) => o.start.toISOString())).toEqual([
			'2026-04-13T14:00:00.000Z',
			'2026-04-20T14:00:00.000Z',
			'2026-04-22T14:00:00.000Z'
		]);
	});

	it('normalizes all-day DATE UNTIL to an inclusive instant', () => {
		const f = fromGoogle(
			{
				id: 'g2',
				summary: 'Trip',
				start: { date: '2026-04-13' },
				end: { date: '2026-04-14' },
				recurrence: ['RRULE:FREQ=DAILY;UNTIL=20260415']
			},
			NY,
			[]
		);
		expect(f.allDay).toBe(true);
		expect(f.startsAt.toISOString()).toBe('2026-04-13T04:00:00.000Z');
		const occ = expand(
			{ id: 'x', ...f },
			new Date('2026-04-01T00:00:00Z'),
			new Date('2026-05-01T00:00:00Z')
		);
		expect(occ).toHaveLength(3);
		// …and goes back to Google as a DATE again.
		expect(toGoogle({ ...f, attendees: [] }).recurrence).toEqual([
			'RRULE:FREQ=DAILY;UNTIL=20260415'
		]);
	});

	it('round-trips a timed event to Google format', () => {
		const body = toGoogle({
			title: 'Review',
			description: null,
			location: null,
			startsAt: new Date('2026-04-13T14:00:00Z'),
			endsAt: new Date('2026-04-13T15:00:00Z'),
			allDay: false,
			timezone: NY,
			rrule: 'FREQ=DAILY',
			exdates: [new Date('2026-04-14T14:00:00Z')],
			reminders: [10, 60],
			attendees: [{ email: 'b@x.com' }]
		});
		expect(body.start).toEqual({ dateTime: '2026-04-13T14:00:00.000Z', timeZone: NY });
		expect(body.recurrence).toEqual([
			'RRULE:FREQ=DAILY',
			'EXDATE;TZID=America/New_York:20260414T100000'
		]);
		expect(parseExdates(body.recurrence!, NY)[0]?.toISOString()).toBe('2026-04-14T14:00:00.000Z');
		expect(body.reminders?.overrides).toHaveLength(2);
	});

	it('builds instance ids', () => {
		expect(instanceId('abc', new Date('2026-04-14T14:00:00Z'), false, NY)).toBe(
			'abc_20260414T140000Z'
		);
		expect(instanceId('abc', new Date('2026-04-14T04:00:00Z'), true, NY)).toBe('abc_20260414');
	});
});

describe('slack helpers', () => {
	it('parses message links', () => {
		expect(
			parseSlackLink(
				'https://acme.slack.com/archives/C024BE91L/p1700000000123456?thread_ts=1699999999.000100&cid=C024BE91L'
			)
		).toEqual({ channel: 'C024BE91L', ts: '1700000000.123456', threadTs: '1699999999.000100' });
		expect(parseSlackLink('https://acme.slack.com/archives/C1/p1700000000123456')?.threadTs).toBe(
			'1700000000.123456'
		);
		expect(parseSlackLink('not a link')).toBeNull();
	});

	it('tokenizes mrkdwn safely', () => {
		const segs = parseMrkdwn(
			'Hey <@U1> see <https://x.dev|docs> *now* `a&lt;b` <javascript:alert(1)|click> &lt;tag&gt;',
			{ U1: 'Sam' }
		);
		expect(segs).toContainEqual({ t: 'user', id: 'U1', v: '@Sam' });
		expect(segs).toContainEqual({ t: 'link', href: 'https://x.dev', v: 'docs' });
		expect(segs).toContainEqual({ t: 'bold', v: 'now' });
		expect(segs).toContainEqual({ t: 'code', v: 'a<b' });
		expect(segs.some((s) => s.t === 'link' && s.href.startsWith('javascript'))).toBe(false);
		expect(mrkdwnToText('<!here> ship it &lt;3')).toBe('@here ship it <3');
	});
});
