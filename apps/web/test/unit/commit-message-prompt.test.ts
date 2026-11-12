import { describe, expect, it } from 'vitest';
import {
	buildCommitMessages,
	cleanCommitMessage,
	commitDigest,
	MAX_DIGEST_CHARS,
	parseDiff
} from '../../src/lib/wrx/commit-message-prompt.js';

const fileDiff = (path: string, added: string[], options: { isNew?: boolean } = {}) =>
	[
		`diff --git a/${path} b/${path}`,
		...(options.isNew ? ['new file mode 100644'] : []),
		`--- a/${path}`,
		`+++ b/${path}`,
		'@@ -1,1 +1,2 @@',
		...added.map((l) => `+${l}`)
	].join('\n');

describe('parseDiff', () => {
	it('splits files and counts lines, without mistaking hunk lines for headers', () => {
		const diff = `${fileDiff('a.ts', ['x'], { isNew: true })}\n${fileDiff('b.ts', ['y', '++z'])}\n--- removed`;
		const files = parseDiff(diff);
		expect(files.map((f) => [f.path, f.kind, f.addedCount, f.removed])).toEqual([
			['a.ts', 'new', 1, 0],
			['b.ts', 'changed', 2, 1]
		]);
	});
});

describe('commitDigest', () => {
	it('lists new files first and reads their comments, names and tests', () => {
		const digest = commitDigest({
			status: ' M src/app.js\n?? src/terminal.js',
			diff: fileDiff('src/app.js', ['const a = 1;', '// Mount the terminal after render']),
			untracked: [
				{
					path: 'src/terminal.js',
					lines: 120,
					head: '// Run tab terminal: a real shell per workspace.\nexport class Terminals {\nconst x = 2;'
				}
			]
		});
		expect(digest).toMatch(
			/^Files \(2 changed\):\n- src\/terminal\.js \(new file, 120 lines\)\n- src\/app\.js \(\+2 -0\)/
		);
		expect(digest).toContain('- Run tab terminal: a real shell per workspace.');
		expect(digest).toContain('- export class Terminals');
		expect(digest).toContain('- Mount the terminal after render');
		expect(digest).not.toContain('const a = 1');
	});

	it('names lockfiles without reading them', () => {
		const digest = commitDigest({
			status: 'M pnpm-lock.yaml',
			diff: `${fileDiff('pnpm-lock.yaml', ['# lock comment'])}\n${fileDiff('package.json', ['    "node-pty": "^1.1.0",'])}`
		});
		expect(digest).toContain('Also updated: pnpm-lock.yaml');
		expect(digest).not.toContain('lock comment');
		expect(digest).toContain('"node-pty": "^1.1.0"');
	});

	it('shares the budget so a huge first file leaves room for the rest', () => {
		const big = fileDiff(
			'big.ts',
			Array.from({ length: 2000 }, (_, i) => `// note ${i}`)
		);
		const small = fileDiff('small.ts', ['// the small file matters too']);
		const digest = commitDigest({ status: '', diff: `${big}\n${small}` });
		expect(digest.length).toBeLessThanOrEqual(MAX_DIGEST_CHARS);
		expect(digest).toContain('the small file matters too');
	});
});

describe('buildCommitMessages', () => {
	it('wraps the digest in changes tags', () => {
		const messages = buildCommitMessages({
			status: ' M a.ts',
			diff: fileDiff('a.ts', ['// add x'])
		})!;
		expect(messages[0]!.role).toBe('system');
		expect(messages[1]!.content).toBe(
			'<changes>\nFiles (1 changed):\n- a.ts (+1 -0)\n\na.ts:\n- add x\n</changes>'
		);
	});

	it('skips empty changes', () => {
		expect(buildCommitMessages({ status: '', diff: '  ' })).toBeNull();
	});

	it('falls back to the status when there is no diff', () => {
		expect(buildCommitMessages({ status: '?? notes/', diff: '' })![1]!.content).toContain(
			'?? notes/'
		);
	});
});

describe('cleanCommitMessage', () => {
	it('keeps a clean subject', () => {
		expect(cleanCommitMessage('Add commit button to changes tab')).toBe(
			'Add commit button to changes tab'
		);
	});

	it('strips prefixes, quotes, and trailing periods', () => {
		expect(cleanCommitMessage('Commit message: "Fix crash on empty list."')).toBe(
			'Fix crash on empty list'
		);
		expect(cleanCommitMessage('<subject>Fix login</subject>')).toBe('Fix login');
	});

	it('keeps only the first line and caps length', () => {
		expect(cleanCommitMessage('\nFix login\n\nMore detail')).toBe('Fix login');
		expect(cleanCommitMessage('word '.repeat(40)).length).toBeLessThanOrEqual(72);
	});
});
