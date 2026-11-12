import { expect, it } from 'vitest';
import { clientChats } from '../../src/lib/server/wrx/core.js';

it('includes an old search target in a bounded window, and preserves latest-message default', () => {
	const messages = Array.from({ length: 300 }, (_, i) => ({
		id: String(i),
		text: `Message ${i}`,
		role: 'user'
	}));
	const chat = { id: 'chat', messages, events: [] };
	const [focused] = clientChats([chat], 'chat', 60, '40');
	expect(focused.messages).toHaveLength(60);
	expect(focused.messages.some((m) => m.id === '40')).toBe(true);
	expect(focused.messageOffset).toBe(10);
	expect(focused.messageAfter).toBe(230);
	const [latest] = clientChats([chat], 'chat', 60);
	expect(latest.messages[0].id).toBe('240');
	expect(latest.messageAfter).toBe(0);
});
