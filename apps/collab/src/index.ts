import { Server } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import { eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { db, env, schema } from '@corpus/db';
import { atLeast, linkRole, noteRole, type NoteRole } from '@corpus/db/access';
import { notify } from '@corpus/db/notify';
import { verifyToken } from '@corpus/core/crypto';

interface Ctx {
	userId: string;
	name: string;
	role: NoteRole;
	guest: boolean;
}

interface TokenPayload extends Record<string, unknown> {
	sub: string;
	name: string;
	note: string;
	role: NoteRole;
	link?: string;
}

const SECRET = env('BETTER_AUTH_SECRET', 'dev-secret-change-me-dev-secret-change-me');
const PORT = Number(env('COLLAB_PORT', '1234'));

const noteIdOf = (documentName: string) => documentName.replace(/^note:/, '');

/** Plain text + mentioned user ids from the ProseMirror Y.XmlFragment. */
function extract(doc: Y.Doc) {
	const mentions = new Set<string>();
	const lines: string[] = [];
	const walk = (node: Y.XmlElement | Y.XmlText | Y.XmlFragment, out: string[]) => {
		if (node instanceof Y.XmlText) {
			out.push(
				node
					.toDelta()
					.map((d: { insert: unknown }) => (typeof d.insert === 'string' ? d.insert : ''))
					.join('')
			);
			return;
		}
		if (node instanceof Y.XmlElement && node.nodeName === 'mention') {
			const id = node.getAttribute('id');
			if (id) mentions.add(String(id));
			out.push(`@${node.getAttribute('label') ?? ''}`);
			return;
		}
		const inner: string[] = [];
		node.toArray().forEach((child) => walk(child as Y.XmlElement | Y.XmlText, inner));
		if (
			node instanceof Y.XmlElement &&
			[
				'paragraph',
				'heading',
				'listItem',
				'taskItem',
				'codeBlock',
				'tableCell',
				'tableHeader'
			].includes(node.nodeName)
		) {
			lines.push(inner.join(''));
		} else out.push(inner.join(''));
	};
	walk(doc.getXmlFragment('default'), []);
	return { text: lines.filter(Boolean).join('\n').slice(0, 100_000), mentions };
}

const server = new Server<Ctx>({
	port: PORT,
	debounce: 1500,
	maxDebounce: 10_000,
	quiet: true,

	async onAuthenticate({ token, documentName, connectionConfig }) {
		const payload = verifyToken<TokenPayload>(token, SECRET);
		const noteId = noteIdOf(documentName);
		if (!payload || payload.note !== noteId) throw new Error('Unauthorized');

		// Re-check live access so revoked shares/links stop working on reconnect.
		let role: NoteRole | null;
		if (payload.link) {
			const link = await linkRole(payload.link);
			role = link?.noteId === noteId ? link.role : null;
		} else {
			role = await noteRole(payload.sub, noteId);
		}
		if (!role) throw new Error('Forbidden');

		connectionConfig.readOnly = !atLeast(role, 'edit');
		return {
			userId: payload.sub,
			name: payload.name,
			role,
			guest: payload.sub.startsWith('guest:')
		} satisfies Ctx;
	},

	extensions: [
		new Database({
			fetch: async ({ documentName }) => {
				const [row] = await db
					.select({ ydoc: schema.note.ydoc })
					.from(schema.note)
					.where(eq(schema.note.id, noteIdOf(documentName)))
					.limit(1);
				return row?.ydoc ?? null;
			},
			store: async ({ documentName, state, document, lastContext }) => {
				const noteId = noteIdOf(documentName);
				const [before] = await db
					.select({
						ydoc: schema.note.ydoc,
						title: schema.note.title,
						workspaceId: schema.note.workspaceId
					})
					.from(schema.note)
					.where(eq(schema.note.id, noteId))
					.limit(1);
				if (!before) return;

				const { text, mentions } = extract(document);
				await db
					.update(schema.note)
					.set({ ydoc: new Uint8Array(state), contentText: text })
					.where(eq(schema.note.id, noteId));

				// Notify newly mentioned users (compare against the previously stored doc).
				let previous = new Set<string>();
				if (before.ydoc) {
					const old = new Y.Doc();
					Y.applyUpdate(old, before.ydoc);
					previous = extract(old).mentions;
					old.destroy();
				}
				const ctx = lastContext as Ctx | undefined;
				const added = [...mentions].filter((id) => !previous.has(id) && id !== ctx?.userId);
				if (added.length) {
					await notify(
						added.map((userId) => ({
							userId,
							workspaceId: before.workspaceId,
							type: 'note_mention' as const,
							title: `${ctx?.name ?? 'Someone'} mentioned you in “${before.title || 'Untitled'}”`,
							href: `/notes/${noteId}`,
							sourceType: 'note',
							sourceId: noteId,
							dedupeKey: `note_mention:${noteId}:${userId}:${Date.now()}`
						}))
					);
				}
			}
		})
	]
});

await server.listen();
console.log(`[collab] Hocuspocus listening on :${PORT}`);
