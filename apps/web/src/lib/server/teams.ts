import { and, eq, gt } from 'drizzle-orm';
import { db, schema } from '@corpus/db';
import type { Ctx } from './ctx.js';
import { workspaceMembers } from './workspaces.js';

const { organization, team, teamMember, invitation, user } = schema;

export async function teamsPage(ctx: Ctx) {
	const [org] = await db
		.select()
		.from(organization)
		.where(eq(organization.id, ctx.workspaceId))
		.limit(1);
	const [members, teams, links, pending, mine] = await Promise.all([
		workspaceMembers(ctx.workspaceId),
		db.select().from(team).where(eq(team.organizationId, ctx.workspaceId)).orderBy(team.name),
		db
			.select({ teamId: teamMember.teamId, userId: teamMember.userId })
			.from(teamMember)
			.innerJoin(team, eq(teamMember.teamId, team.id))
			.where(eq(team.organizationId, ctx.workspaceId)),
		db
			.select({
				id: invitation.id,
				email: invitation.email,
				role: invitation.role,
				teamId: invitation.teamId,
				expiresAt: invitation.expiresAt
			})
			.from(invitation)
			.where(
				and(
					eq(invitation.organizationId, ctx.workspaceId),
					eq(invitation.status, 'pending'),
					gt(invitation.expiresAt, new Date())
				)
			),
		invitationsFor(ctx.user.email)
	]);
	const myRole = members.find((m) => m.id === ctx.userId)?.role ?? 'member';
	return {
		org: org ? { id: org.id, name: org.name, slug: org.slug, kind: org.kind ?? 'org' } : null,
		myRole,
		members,
		teams: teams.map((t) => ({
			id: t.id,
			name: t.name,
			memberIds: links.filter((l) => l.teamId === t.id).map((l) => l.userId)
		})),
		pending,
		invitations: mine
	};
}

export async function invitationsFor(email: string) {
	return db
		.select({
			id: invitation.id,
			role: invitation.role,
			orgName: organization.name,
			orgKind: organization.kind,
			inviterName: user.name,
			expiresAt: invitation.expiresAt
		})
		.from(invitation)
		.innerJoin(organization, eq(invitation.organizationId, organization.id))
		.innerJoin(user, eq(invitation.inviterId, user.id))
		.where(
			and(
				eq(invitation.email, email.toLowerCase()),
				eq(invitation.status, 'pending'),
				gt(invitation.expiresAt, new Date())
			)
		);
}

export async function invitationById(id: string) {
	const [row] = await db
		.select({
			id: invitation.id,
			email: invitation.email,
			status: invitation.status,
			role: invitation.role,
			expiresAt: invitation.expiresAt,
			orgName: organization.name,
			orgKind: organization.kind,
			inviterName: user.name
		})
		.from(invitation)
		.innerJoin(organization, eq(invitation.organizationId, organization.id))
		.innerJoin(user, eq(invitation.inviterId, user.id))
		.where(eq(invitation.id, id))
		.limit(1);
	return row ?? null;
}
