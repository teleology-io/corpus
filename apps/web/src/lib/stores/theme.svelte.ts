export type ThemePref = 'light' | 'dark' | 'system';

const KEY = 'corpus-theme';

function read(): ThemePref {
	try {
		const v = localStorage.getItem(KEY);
		return v === 'dark' || v === 'system' ? v : 'light';
	} catch {
		return 'light';
	}
}

class Theme {
	/** Light (the original corpus.webp look) unless the user opts into dark/system. */
	pref = $state<ThemePref>('light');
	dark = $state(false);
	private media: MediaQueryList | null = null;

	/** Call once on the client; app.html already applied the class before paint. */
	init() {
		if (this.media) return;
		this.media = matchMedia('(prefers-color-scheme: dark)');
		this.media.addEventListener('change', () => this.pref === 'system' && this.apply());
		this.pref = read();
		this.apply();
	}

	set(pref: ThemePref) {
		this.pref = pref;
		try {
			if (pref === 'light') localStorage.removeItem(KEY);
			else localStorage.setItem(KEY, pref);
		} catch {
			/* storage unavailable — still applies for this session */
		}
		this.apply();
	}

	private apply() {
		this.dark = this.pref === 'dark' || (this.pref === 'system' && !!this.media?.matches);
		document.documentElement.classList.toggle('dark', this.dark);
		document
			.querySelector('meta[name="theme-color"]')
			?.setAttribute('content', this.dark ? '#16191f' : '#2C87F2');
	}
}

export const theme = new Theme();
