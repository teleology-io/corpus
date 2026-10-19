import { eq } from 'drizzle-orm';
import nodemailer, { type Transporter } from 'nodemailer';
import { db, env, schema } from '@corpus/db';
import { notify } from '@corpus/db/notify';

let transport: Transporter | null = null;
const mailer = () =>
	(transport ??= nodemailer.createTransport(env('SMTP_URL', 'smtp://localhost:1025')));

interface InviteData {
	id: string;
	email: string;
	inviter: { user: { name: string } };
	organization: { name: string };
}

/**
 * Better Auth invitation hook: existing users get an in-app notification (plus email via prefs);
 * new people get an email with a sign-up link that lands on the accept page.
 */
export async function sendInvitation(data: InviteData) {
	const appUrl = env('PUBLIC_APP_URL', 'http://localhost:5173');
	const link = `${appUrl}/teams/invite/${data.id}`;
	const title = `${data.inviter.user.name} invited you to ${data.organization.name}`;
	const [existing] = await db
		.select({ id: schema.user.id })
		.from(schema.user)
		.where(eq(schema.user.email, data.email.toLowerCase()))
		.limit(1);
	if (existing) {
		await notify({
			userId: existing.id,
			type: 'team_invite',
			title,
			body: 'Open to accept or decline.',
			href: `/teams/invite/${data.id}`,
			sourceType: 'invitation',
			sourceId: data.id,
			dedupeKey: `team_invite:${data.id}`
		});
		return;
	}
	await mailer().sendMail({
		from: env('EMAIL_FROM', 'Corpus <no-reply@corpus.local>'),
		to: data.email,
		subject: title,
		text: `${title} on Corpus.\n\nAccept the invitation: ${link}\n\n(Create an account with this email address first if you don't have one.)`,
		html: `<p>${title.replace(/</g, '&lt;')} on Corpus.</p><p><a href="${link}">Accept the invitation</a></p><p style="color:#6b7280">Create an account with this email address first if you don't have one.</p>`
	});
}
