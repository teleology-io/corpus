export type SidebarMode = 'full' | 'compact';

/** A collapsible desktop sidebar's width, remembered per device. */
class SidebarPref {
	mode = $state<SidebarMode>('full');
	compact = $derived(this.mode === 'compact');
	private ready = false;

	/** `htmlClass` mirrors the mode onto <html> (app.html applies it before paint). */
	constructor(
		private key: string,
		private htmlClass?: string
	) {}

	init() {
		if (this.ready) return;
		this.ready = true;
		try {
			this.mode = localStorage.getItem(this.key) === 'compact' ? 'compact' : 'full';
		} catch {
			/* storage unavailable */
		}
	}

	set(mode: SidebarMode) {
		this.mode = mode;
		try {
			if (mode === 'full') localStorage.removeItem(this.key);
			else localStorage.setItem(this.key, mode);
		} catch {
			/* still applies for this session */
		}
		if (this.htmlClass)
			document.documentElement.classList.toggle(this.htmlClass, mode === 'compact');
	}

	toggle() {
		this.set(this.compact ? 'full' : 'compact');
	}
}

/** The app-wide main menu. */
export const sidebar = new SidebarPref('corpus-sidebar', 'sidebar-compact');
/** The Workbench projects panel. */
export const workbenchSidebar = new SidebarPref('wrx.sidebar');
