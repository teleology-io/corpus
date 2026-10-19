import { and, asc, eq, sql } from 'drizzle-orm';
import { db, schema } from '@corpus/db';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function slugify(input: string) {
	return (
		input
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '')
			.slice(0, 40) || 'workspace'
	);
}

/**
 * Every user gets a personal workspace (organization kind=personal) plus a default calendar.
 * Idempotent and race-safe: the sign-up hook and the request-time fallback may both call it.
 */
export async function onUserCreated(user: { id: string; name: string; email: string }) {
	return db.transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'personal:' + user.id}))`);
		const [existing] = await tx
			.select({ id: schema.organization.id })
			.from(schema.member)
			.innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
			.where(and(eq(schema.member.userId, user.id), eq(schema.organization.kind, 'personal')))
			.limit(1);
		if (existing) return existing.id;

		const orgId = crypto.randomUUID();
		const now = new Date();
		await tx.insert(schema.organization).values({
			id: orgId,
			name: 'Personal',
			slug: `${slugify(user.name || user.email.split('@')[0]!)}-${orgId.slice(0, 6)}`,
			kind: 'personal',
			createdAt: now
		});
		await tx.insert(schema.member).values({
			id: crypto.randomUUID(),
			organizationId: orgId,
			userId: user.id,
			role: 'owner',
			createdAt: now
		});
		await seedWorkspace(orgId, user.id, tx);
		return orgId;
	});
}

/** Default calendar + "Mark Schedule" categories for a new workspace. */
export async function seedWorkspace(workspaceId: string, userId: string, tx: Tx | typeof db = db) {
	await tx.insert(schema.calendar).values({
		workspaceId,
		name: 'Calendar',
		color: '#2C87F2',
		isDefault: true,
		createdBy: userId
	});
	await tx
		.insert(schema.category)
		.values(schema.DEFAULT_CATEGORIES.map((c) => ({ ...c, workspaceId })));
}

/** Personal workspace first, otherwise oldest membership. */
export async function initialWorkspaceId(userId: string): Promise<string | undefined> {
	const rows = await db
		.select({ id: schema.organization.id, kind: schema.organization.kind })
		.from(schema.member)
		.innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
		.where(eq(schema.member.userId, userId))
		.orderBy(asc(schema.member.createdAt));
	return (rows.find((r) => r.kind === 'personal') ?? rows[0])?.id;
}

export async function isMember(userId: string, workspaceId: string) {
	const [row] = await db
		.select({ id: schema.member.id })
		.from(schema.member)
		.where(and(eq(schema.member.userId, userId), eq(schema.member.organizationId, workspaceId)))
		.limit(1);
	return !!row;
}

/**
 * Workspace for a request: keep the session's active one if the user is still a member,
 * otherwise fall back to (creating if needed) their personal workspace and persist it.
 */
export async function resolveWorkspace(
	user: { id: string; name: string; email: string },
	session: { id: string; activeOrganizationId?: string | null }
): Promise<string> {
	const current = session.activeOrganizationId;
	if (current && (await isMember(user.id, current))) return current;
	const workspaceId = (await initialWorkspaceId(user.id)) ?? (await onUserCreated(user));
	await db
		.update(schema.session)
		.set({ activeOrganizationId: workspaceId })
		.where(eq(schema.session.id, session.id));
	return workspaceId;
}
