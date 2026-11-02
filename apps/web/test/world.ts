import { addMember, makeLink, makeNote, makeUser, makeWorkspace, reset } from './fixtures';

/**
 * Shared scenario:
 *  - W1 (org): A creator (plain member), B member, D admin, O owner
 *  - C: outsider with their own personal workspace CW
 *  - N: note in W1 created by A, with a public *edit* link; K: child of N, also by A
 */
export async function world() {
	await reset();
	const [A, B, C, D, O] = await Promise.all(
		['Ada', 'Ben', 'Cy', 'Dee', 'Oz'].map((n) => makeUser(n))
	);
	const W1 = await makeWorkspace('Acme');
	const CW = await makeWorkspace('Cy-personal', 'personal');
	await addMember(W1, A.id, 'member');
	await addMember(W1, B.id, 'member');
	await addMember(W1, D.id, 'admin');
	await addMember(W1, O.id, 'owner');
	await addMember(CW, C.id, 'owner');
	const N = await makeNote(W1, A.id);
	const K = await makeNote(W1, A.id, N.id);
	const link = await makeLink(N.id, 'edit', A.id);
	return { A, B, C, D, O, W1, CW, N, K, link };
}
