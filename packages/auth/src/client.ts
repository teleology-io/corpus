import { createAuthClient } from 'better-auth/svelte';
import {
	organizationClient,
	twoFactorClient,
	inferAdditionalFields,
	inferOrgAdditionalFields
} from 'better-auth/client/plugins';
import type { Auth } from './index';

export const authClient = createAuthClient({
	plugins: [
		inferAdditionalFields<Auth>(),
		organizationClient({ teams: { enabled: true }, schema: inferOrgAdditionalFields<Auth>() }),
		twoFactorClient({
			onTwoFactorRedirect() {
				window.location.href = '/two-factor';
			}
		})
	]
});
