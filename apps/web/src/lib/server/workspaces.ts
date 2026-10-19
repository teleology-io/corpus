import { and, eq } from 'drizzle-orm';
import { db, schema } from '@corpus/db';

export async function listWorkspaces(userId: string) {
	return db
		.select({
			id: schema.organization.id,
			name: schema.organization.name,
			slug: schema.organization.slug,
			logo: schema.organization.logo,
			kind: schema.organization.kind,
			role: schema.member.role
		})
		.from(schema.member)
		.innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
		.where(eq(schema.member.userId, userId))
		.orderBy(schema.member.createdAt);
}

export async function membership(userId: string, workspaceId: string) {
	const [row] = await db
		.select({ role: schema.member.role })
		.from(schema.member)
		.where(and(eq(schema.member.userId, userId), eq(schema.member.organizationId, workspaceId)))
		.limit(1);
	return row ?? null;
}

export async function workspaceMembers(workspaceId: string) {
	return db
		.select({
			memberId: schema.member.id,
			id: schema.user.id,
			name: schema.user.name,
			email: schema.user.email,
			image: schema.user.image,
			role: schema.member.role,
			joinedAt: schema.member.createdAt
		})
		.from(schema.member)
		.innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
		.where(eq(schema.member.organizationId, workspaceId))
		.orderBy(schema.member.createdAt);
}
