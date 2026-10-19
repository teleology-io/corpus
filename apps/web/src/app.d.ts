import type { Session } from '@corpus/auth';

declare global {
	namespace App {
		interface Locals {
			user: Session['user'] | null;
			session: Session['session'] | null;
			/** Active workspace (organization) id */
			workspaceId: string | null;
		}
		interface PageData {
			title?: string;
			workspaceId?: string;
			workspaces?: {
				id: string;
				name: string;
				slug: string;
				logo: string | null;
				kind: string | null;
				role: string;
			}[];
		}
	}
}

export {};
