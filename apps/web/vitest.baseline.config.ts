import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * Regression check: runs the sharing tests against the pre-fix notes service without
 * touching the working tree. The pinned commit's lib/server/notes.ts is copied to an
 * ignored file under test/.baseline/ and swapped in via an alias for `#lib/server/notes.js`
 * only — every other module (access.ts, routes, fixtures) is the current code.
 *
 *   pnpm --filter web exec vitest run -c vitest.baseline.config.ts test/note-sharing.service.test.ts
 *
 * Expected on the baseline: S1–S4, S6, S10 and "admin of a different workspace" FAIL (the
 * leak and the missing manager check); S5, S7, S8, S9, S11, "no access → 404" and the
 * multi-role case pass (old code let any editor manage).
 */
// Pinned pre-fix commit (session start, before any slice-1 edit) so the comparison is
// reproducible regardless of later commits. Override only to re-baseline deliberately.
const ref = process.env.BASELINE_REF ?? '719c512eaaca918227479b50501c260c435134b5';
const dir = fileURLToPath(new URL('./test/.baseline/', import.meta.url));
const target = `${dir}notes.ts`;
mkdirSync(dir, { recursive: true });
writeFileSync(
	target,
	execFileSync('git', ['show', `${ref}:apps/web/src/lib/server/notes.ts`], {
		cwd: fileURLToPath(new URL('.', import.meta.url)),
		encoding: 'utf8'
	})
);

export default mergeConfig(
	base,
	defineConfig({
		resolve: { alias: [{ find: /^#lib\/server\/notes\.js$/, replacement: target }] }
	})
);
