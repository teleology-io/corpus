// Grant or revoke admin panel access.
//   pnpm --filter admin grant <email>            grant
//   pnpm --filter admin grant <email> --revoke   revoke
import { adminAudit, db, sql, user } from '@corpus/db';
import { eq, sql as q } from 'drizzle-orm';

const email = process.argv[2]?.trim().toLowerCase();
const revoke = process.argv.includes('--revoke');
if (!email || email.startsWith('-')) {
	console.error('Usage: pnpm --filter admin grant <email> [--revoke]');
	process.exit(1);
}

const [row] = await db
	.update(user)
	.set({ superadmin: !revoke })
	.where(eq(q`lower(${user.email})`, email))
	.returning({ id: user.id, email: user.email });

if (!row) {
	console.error(`No user with email ${email}`);
	await sql.end();
	process.exit(1);
}

await db.insert(adminAudit).values({
	actorId: null,
	actorEmail: 'cli',
	action: revoke ? 'superadmin.revoke' : 'superadmin.grant',
	targetType: 'user',
	targetId: row.id
});
console.log(`${revoke ? 'Revoked' : 'Granted'} superadmin: ${row.email}`);
await sql.end();
