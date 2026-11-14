import { fail } from '@sveltejs/kit';
import { adminAudit, db, sql } from '@corpus/db';

/** Write side of the admin panel. Every mutation goes through `logAction`. */

export type Admin = NonNullable<App.Locals['admin']>;

export async function logAction(
	admin: Admin,
	action: string,
	target: { type: string; id: string; label?: string },
	reason: string | null = null,
	meta: Record<string, unknown> = {}
) {
	await db.insert(adminAudit).values({
		actorId: admin.id,
		actorEmail: admin.email,
		action,
		targetType: target.type,
		targetId: target.id,
		reason,
		meta: { ...meta, label: target.label ?? target.id }
	});
}

/** Reads the confirm modal's reason; destructive actions must have one. */
export function requireReason(form: FormData) {
	const reason = String(form.get('reason') ?? '').trim();
	if (reason.length < 3) return { error: fail(400, { error: 'A reason is required.' }) } as const;
	return { reason: reason.slice(0, 500) } as const;
}

/** Revoke every session for a user. Returns how many were removed. */
export async function revokeSessions(userId: string) {
	const rows = await sql`delete from session where user_id = ${userId} returning id`;
	return rows.length;
}

export async function setDisabled(userId: string, disabled: boolean) {
	await sql`update "user" set disabled = ${disabled}, updated_at = now() where id = ${userId}`;
	if (disabled) await revokeSessions(userId);
}

/**
 * Ask the worker to poll one connection now, clearing its backoff. Errored connections are
 * reactivated; if the token is really bad the poll puts them straight back into `error`.
 * Revoked connections are left alone (the user disconnected them).
 */
export async function retryConnection(id: string) {
	const [row] = await sql<{ provider: string }[]>`
		update integration_connection
		set status = 'active', failure_count = 0, next_poll_at = now(), updated_at = now()
		where id = ${id} and status <> 'revoked' returning provider`;
	if (row) await sql.notify('corpus_poll', id);
	return row ?? null;
}
