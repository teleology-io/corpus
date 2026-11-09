import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import os from 'node:os';

// Listen on every interface so other machines on the network can open the app by IP or by this
// machine's Bonjour name (Vite rejects unknown Host headers, so allow <hostname>.local too).
const lanName = `${os.hostname().replace(/\.local$/i, '')}.local`.toLowerCase();
// Fixed port, away from Vite's default 5173 so Corpus doesn't collide with other local projects.
// strictPort: fail loudly instead of drifting to another port, which would break auth (PUBLIC_APP_URL).
const lan = {
	host: '0.0.0.0',
	port: 2222,
	strictPort: true,
	allowedHosts: [lanName, 'localhost']
};

export default defineConfig({
	server: {
		...lan,
		// Workbench state lives here, including whole PR trees unpacked for Integration Review.
		// Watching them reloads the server mid-request whenever a review starts or ends.
		watch: { ignored: ['**/.wrx/**'] }
	},
	preview: lan,
	// The rewrite worker pulls in Transformers.js, whose dynamic imports need code splitting.
	worker: { format: 'es' },
	ssr: {
		// Bundle (and tree-shake) date-fns for the server. Left external, the first page render
		// imported its whole barrel — ~860 module resolutions, ~1.7s on a cold server.
		noExternal: ['date-fns']
	},
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter()
		})
	]
});
