/** Open state of the app-wide ⌘K search palette (GlobalSearch in the app layout). */
export const search = $state({ open: false });

export const openSearch = () => (search.open = true);
