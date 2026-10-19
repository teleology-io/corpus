import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization, twoFactor } from 'better-auth/plugins';
import { db, env, optionalEnv, schema } from '@corpus/db';
import { onUserCreated, initialWorkspaceId, seedWorkspace } from './workspace';

export { resolveWorkspace } from './workspace';
import { sendInvitation } from './email';

const githubId = optionalEnv('GITHUB_CLIENT_ID');
const githubSecret = optionalEnv('GITHUB_CLIENT_SECRET');

export const auth = betterAuth({
	appName: 'Corpus',
	baseURL: env('PUBLIC_APP_URL', 'http://localhost:5173'),
	secret: env('BETTER_AUTH_SECRET', 'dev-secret-change-me-dev-secret-change-me'),
	database: drizzleAdapter(db, { provider: 'pg', schema }),
	emailAndPassword: { enabled: true, autoSignIn: true },
	socialProviders:
		githubId && githubSecret
			? { github: { clientId: githubId, clientSecret: githubSecret } }
			: undefined,
	user: {
		additionalFields: {
			timezone: { type: 'string', required: false, defaultValue: 'UTC', input: true },
			weekStartsOn: { type: 'number', required: false, defaultValue: 0, input: true }
		}
	},
	databaseHooks: {
		user: {
			create: {
				after: async (user) => {
					await onUserCreated(user);
				}
			}
		},
		session: {
			create: {
				before: async (session) => {
					const workspaceId = await initialWorkspaceId(session.userId);
					return { data: { ...session, activeOrganizationId: workspaceId } };
				}
			}
		}
	},
	plugins: [
		organization({
			teams: { enabled: true, maximumTeams: 50 },
			invitationExpiresIn: 60 * 60 * 24 * 7,
			sendInvitationEmail: sendInvitation,
			organizationHooks: {
				afterCreateOrganization: async ({ organization, user }) => {
					await seedWorkspace(organization.id, user.id);
				}
			},
			schema: {
				organization: {
					additionalFields: {
						// personal | org | family
						kind: { type: 'string', required: false, defaultValue: 'org', input: true }
					}
				}
			}
		}),
		twoFactor({ issuer: 'Corpus' })
	]
});

export type Auth = typeof auth;
export type Session = typeof auth.$Infer.Session;
