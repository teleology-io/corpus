// Stand-in for SvelteKit's `$app/env` in tests, which run without the SvelteKit plugin.
// Matches `vite dev`: dev on, not building, server side.
export const browser = false;
export const dev = true;
export const building = false;
export const version = 'test';
