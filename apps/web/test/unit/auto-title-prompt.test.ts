import { describe, expect, it } from 'vitest';
import {
	buildTitleMessages,
	cleanTitle
} from '../../src/lib/components/telescope/auto-title-prompt.js';

const seg = (text: string) => ({ start: 0, end: 1, text });

describe('buildTitleMessages', () => {
	it('joins the segments inside transcript tags', () => {
		const messages = buildTitleMessages([seg('Walking through the'), seg('new billing page')])!;
		expect(messages[0]!.role).toBe('system');
		expect(messages[1]!.content).toBe(
			'<transcript>\nWalking through the new billing page\n</transcript>'
		);
	});

	it('skips transcripts too short to describe', () => {
		expect(buildTitleMessages([])).toBeNull();
		expect(buildTitleMessages([seg('Testing one two')])).toBeNull();
	});

	it('caps long transcripts', () => {
		const messages = buildTitleMessages([seg('word '.repeat(5000))])!;
		expect(messages[1]!.content.length).toBeLessThan(4100);
	});
});

describe('cleanTitle', () => {
	it('keeps a clean title', () => {
		expect(cleanTitle('Billing Page Walkthrough')).toBe('Billing Page Walkthrough');
	});

	it('strips the wrappers small models add', () => {
		expect(cleanTitle('"Billing Page Walkthrough"')).toBe('Billing Page Walkthrough');
		expect(cleanTitle('Title: "Billing Page Walkthrough".')).toBe('Billing Page Walkthrough');
		expect(cleanTitle('**Title:** Billing Page Walkthrough')).toBe('Billing Page Walkthrough');
		expect(cleanTitle('# Billing Page Walkthrough')).toBe('Billing Page Walkthrough');
		expect(cleanTitle('<title>Billing Page Walkthrough</title>')).toBe('Billing Page Walkthrough');
	});

	it('uses only the first line', () => {
		expect(cleanTitle('\nBilling Page Walkthrough\nThis title describes it.')).toBe(
			'Billing Page Walkthrough'
		);
	});

	it('cuts long titles at a word', () => {
		const title = cleanTitle('walkthrough '.repeat(20));
		expect(title.length).toBeLessThanOrEqual(80);
		expect(title.endsWith('walkthrough')).toBe(true);
	});

	it('returns nothing for empty output', () => {
		expect(cleanTitle('  \n ')).toBe('');
		expect(cleanTitle('""')).toBe('');
	});
});
