const COLORS = ['#2C87F2', '#E5484D', '#30A46C', '#F5A524', '#8E4EC6', '#0EA5A4', '#E93D82'];

/** Stable caret color per user id. */
export function colorFor(id: string) {
	let h = 0;
	for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
	return COLORS[h % COLORS.length]!;
}

export const EMOJI = [
	'📄',
	'📝',
	'📌',
	'📚',
	'🗂️',
	'💡',
	'✅',
	'🚀',
	'🎯',
	'🧠',
	'💊',
	'🏥',
	'🏠',
	'👪',
	'💼',
	'📈',
	'🛠️',
	'🎨',
	'✈️',
	'🍽️',
	'💰',
	'❤️',
	'⭐',
	'🔒'
];
