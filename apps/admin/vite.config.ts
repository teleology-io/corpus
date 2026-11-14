import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Fixed port next to the main app (2222). Localhost only: this panel controls infrastructure and
// must not be reachable from the LAN. strictPort: fail loudly instead of drifting.
const server = { host: 'localhost', port: 2223, strictPort: true };

export default defineConfig({
	server,
	preview: server,
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter()
		})
	]
});
