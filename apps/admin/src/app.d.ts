import type { Session } from '@corpus/auth';

declare global {
	namespace App {
		interface Locals {
			/** Set only for signed-in superadmins; every other request is turned away in hooks. */
			admin: Pick<Session['user'], 'id' | 'name' | 'email' | 'image'> | null;
		}
	}
}

export {};
