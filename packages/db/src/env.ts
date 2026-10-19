import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from 'dotenv';

let loaded = false;

/** Load the repo-root .env (walks up from cwd) so every app shares one config. */
export function loadEnv() {
	if (loaded) return;
	loaded = true;
	let dir = process.cwd();
	for (let i = 0; i < 6; i++) {
		const file = join(dir, '.env');
		if (existsSync(file)) {
			config({ path: file, quiet: true });
			return;
		}
		const parent = dirname(dir);
		if (parent === dir) return;
		dir = parent;
	}
}

export function env(name: string, fallback?: string): string {
	loadEnv();
	const value = process.env[name] ?? fallback;
	if (value === undefined) throw new Error(`Missing env var ${name}`);
	return value;
}

export function optionalEnv(name: string): string | undefined {
	loadEnv();
	return process.env[name] || undefined;
}
