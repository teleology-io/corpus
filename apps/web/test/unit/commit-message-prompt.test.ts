import { describe, expect, it } from 'vitest';
import {
	buildCommitMessages,
	cleanCommitMessage
} from '../../src/lib/wrx/commit-message-prompt.js';

describe('buildCommitMessages', () => {
	it('puts status and diff inside changes tags', () => {
		const messages = buildCommitMessages(' M a.ts', '+const x = 1;')!;
		expect(messages[0]!.role).toBe('system');
		expect(messages[1]!.content).toBe(
			'<changes>\nFiles:\nM a.ts\n\nDiff:\n+const x = 1;\n</changes>'
		);
	});

	it('skips empty changes', () => {
		expect(buildCommitMessages('', '  ')).toBeNull();
	});

	it('caps long diffs', () => {
		const messages = buildCommitMessages('M a.ts', '+x\n'.repeat(5000))!;
		expect(messages[1]!.content.length).toBeLessThan(4100);
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
