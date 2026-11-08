import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine, Store } from '../../src/lib/server/wrx/core.js';
import { searchFiles } from '../../src/lib/server/wrx/files.js';

let dir: string;
let folder: string;
let engine: Engine;

beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-folder-')));
	folder = path.join(dir, 'novel');
	fs.mkdirSync(path.join(folder, 'chapters'), { recursive: true });
	fs.writeFileSync(path.join(folder, 'chapters', 'one.md'), '# One');
	fs.mkdirSync(path.join(folder, '.hidden'));
	fs.writeFileSync(path.join(folder, '.hidden', 'one.md'), '');
	engine = new Engine(new Store(path.join(dir, 'state')), () => {});
});
afterEach(() => {
	if (engine.changeTimer) clearTimeout(engine.changeTimer);
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('a project that is a plain folder', () => {
	it('opens with a main workspace on a generic branch', async () => {
		const project = await engine.project({ path: folder });
		expect(project).toMatchObject({ name: 'novel', path: folder, folder: true });
		const [workspace] = engine.store.state.workspaces;
		expect(workspace).toMatchObject({ name: 'Main workspace', branch: 'master', path: folder });
		await expect(engine.project({ path: folder })).rejects.toThrow(/folder is already registered/);
	});

	it('refuses new workspaces with a reason', async () => {
		const project = await engine.project({ path: folder });
		await expect(
			engine.workspace({ projectId: project.id, name: 'Draft', branch: 'draft' })
		).rejects.toThrow(/isn't a Git repository/);
		expect(engine.store.state.workspaces).toHaveLength(1);
	});

	it('shows no changes, and tells agents nothing about worktrees', async () => {
		await engine.project({ path: folder });
		const [workspace] = engine.store.state.workspaces;
		expect(await engine.diff(workspace.id)).toEqual({ status: '', diff: '', log: '' });
		expect(engine.worktreesContext(workspace)).toBe('');
	});

	it('searches files without Git, leaving hidden folders out', async () => {
		expect((await searchFiles(folder, 'one')).map((f: { path: string }) => f.path)).toEqual([
			'chapters/one.md'
		]);
	});

	it('still opens a subfolder of a repository as that repository', async () => {
		const git = (...args: string[]) => execFileSync('git', args, { cwd: folder, stdio: 'pipe' });
		git('init', '-q', '-b', 'trunk');
		const project = await engine.project({ path: path.join(folder, 'chapters') });
		expect(project.path).toBe(folder);
		expect(project).not.toHaveProperty('folder');
		expect(engine.store.state.workspaces[0].branch).toBe('trunk');
		expect(engine.worktreesContext(engine.store.state.workspaces[0])).toContain('Worktrees');
	});
});
