import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization, twoFactor } from 'better-auth/plugins';
import { db, env, optionalEnv, schema } from '@corpus/db';
import { onUserCreated, initialWorkspaceId, seedWorkspace } from './workspace';

export { resolveWorkspace } from './workspace';
import { sendInvitation } from './email';
import os from 'node:os';

const githubId = optionalEnv('GITHUB_CLIENT_ID');
const githubSecret = optionalEnv('GITHUB_CLIENT_SECRET');
const baseURL = env('PUBLIC_APP_URL', 'http://localhost:2222');

// When the app runs on localhost (dev), also accept sign-in from other machines on the LAN that
// open it by this host's IP or <hostname>.local — better-auth rejects unknown Origins otherwise.
function lanOrigins(): string[] {
	const base = new URL(baseURL);
	if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) return [];
	const hosts = [
		`${os.hostname().replace(/\.local$/i, '')}.local`.toLowerCase(),
		...Object.values(os.networkInterfaces())
			.flat()
			.filter((a) => a && !a.internal && a.family === 'IPv4')
			.map((a) => a!.address)
	];
	return hosts.map((h) => `${base.protocol}//${h}${base.port ? `:${base.port}` : ''}`);
}

export const auth = betterAuth({
	appName: 'Corpus',
	baseURL,
	trustedOrigins: lanOrigins(),
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
