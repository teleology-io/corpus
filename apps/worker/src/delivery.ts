import { eq, inArray, sql as dsql } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import webpush from 'web-push';
import { db, env, optionalEnv, schema, sql } from '@corpus/db';
import { inQuietHours } from '@corpus/core';

const appUrl = env('PUBLIC_APP_URL', 'http://localhost:5173');
const mailer = nodemailer.createTransport(env('SMTP_URL', 'smtp://localhost:1025'));
const from = env('EMAIL_FROM', 'Corpus <no-reply@corpus.local>');

const vapidPublic = optionalEnv('PUBLIC_VAPID_KEY');
const vapidPrivate = optionalEnv('VAPID_PRIVATE_KEY');
const pushEnabled = !!(vapidPublic && vapidPrivate);
if (pushEnabled)
	webpush.setVapidDetails(
		env('VAPID_SUBJECT', 'mailto:admin@corpus.local'),
		vapidPublic!,
		vapidPrivate!
	);
else console.warn('[delivery] VAPID keys missing — web push disabled');

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function emailHtml(n: { title: string; body: string | null; href: string | null }) {
	const link = n.href ? `${appUrl}${n.href}` : appUrl;
	return `<!doctype html><html><body style="margin:0;background:#f7f8fa;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e9ebef;border-radius:14px">
<tr><td style="padding:24px 28px 8px"><span style="display:inline-block;background:#2C87F2;color:#fff;border-radius:8px;padding:4px 10px;font-weight:700;font-size:14px">Corpus</span></td></tr>
<tr><td style="padding:8px 28px 0;font-size:18px;font-weight:600;color:#111827">${escape(n.title)}</td></tr>
${n.body ? `<tr><td style="padding:8px 28px 0;font-size:14px;line-height:1.6;color:#4b5563;white-space:pre-line">${escape(n.body)}</td></tr>` : ''}
<tr><td style="padding:20px 28px 28px"><a href="${link}" style="display:inline-block;background:#2C87F2;color:#fff;text-decoration:none;border-radius:8px;padding:10px 16px;font-size:14px;font-weight:600">Open Corpus</a></td></tr>
</table>
<p style="font-size:12px;color:#9ca3af">Manage notifications in <a href="${appUrl}/settings#notifications" style="color:#9ca3af">Settings</a>.</p>
</td></tr></table></body></html>`;
}

const localHHmm = (tz: string) =>
	new Intl.DateTimeFormat('en-GB', {
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
		timeZone: tz
	}).format(new Date());

interface PendingRow {
	id: string;
	channel: string;
	attempts: number;
	title: string;
	body: string | null;
	href: string | null;
	type: string;
	user_id: string;
	email: string;
	timezone: string | null;
	quiet_start: string | null;
	quiet_end: string | null;
}

/** Claim and send a batch of pending deliveries. Safe across multiple workers (SKIP LOCKED). */
export async function deliverPending() {
	await sql.begin(async (tx) => {
		const rows = await tx<PendingRow[]>`
			select d.id, d.channel, d.attempts, n.title, n.body, n.href, n.type, n.user_id,
				u.email, u.timezone, s.quiet_start, s.quiet_end
			from notification_delivery d
			join notification n on n.id = d.notification_id
			join "user" u on u.id = n.user_id
			left join notification_settings s on s.user_id = n.user_id
			where d.status = 'pending' and d.attempts < 5
			order by d.created_at
			limit 50
			for update of d skip locked`;

		for (const row of rows) {
			let status: 'sent' | 'failed' | 'skipped' | 'pending' = 'sent';
			let error: string | null = null;
			try {
				if (row.channel === 'push') {
					if (!pushEnabled) status = 'skipped';
					else if (inQuietHours(localHHmm(row.timezone || 'UTC'), row.quiet_start, row.quiet_end))
						status = 'skipped';
					else await sendPush(row);
				} else if (row.channel === 'email') {
					await mailer.sendMail({
						from,
						to: row.email,
						subject: row.title,
						text: [row.title, row.body, row.href ? `${appUrl}${row.href}` : appUrl]
							.filter(Boolean)
							.join('\n\n'),
						html: emailHtml(row)
					});
				}
			} catch (e) {
				error = (e as Error).message;
				status = row.attempts + 1 >= 5 ? 'failed' : 'pending';
			}
			await tx`
				update notification_delivery
				set status = ${status}, error = ${error}, attempts = attempts + 1,
					sent_at = ${status === 'sent' ? new Date() : null}
				where id = ${row.id}`;
		}
	});
}

async function sendPush(row: PendingRow) {
	const subs = await db
		.select()
		.from(schema.pushSubscription)
		.where(eq(schema.pushSubscription.userId, row.user_id));
	if (!subs.length) return;
	const payload = JSON.stringify({
		title: row.title,
		body: row.body,
		href: row.href,
		tag: row.type
	});
	const gone: string[] = [];
	const results = await Promise.allSettled(
		subs.map((s) =>
			webpush
				.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, { TTL: 60 * 60 })
				.catch((e: { statusCode?: number }) => {
					if (e.statusCode === 404 || e.statusCode === 410) gone.push(s.id);
					else throw e;
				})
		)
	);
	if (gone.length)
		await db.delete(schema.pushSubscription).where(inArray(schema.pushSubscription.id, gone));
	const failed = results.filter((r) => r.status === 'rejected');
	if (failed.length && failed.length === subs.length - gone.length)
		throw (failed[0] as PromiseRejectedResult).reason;
}

/** Drop old read notifications so the table stays small. */
export async function cleanup() {
	await db.execute(
		dsql`delete from notification where read_at is not null and created_at < now() - interval '60 days'`
	);
}
