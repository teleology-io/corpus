/* eslint-disable @typescript-eslint/ban-ts-comment, no-empty, preserve-caught-error -- verbatim WRX port */
// @ts-nocheck — ported verbatim from WRX (plain JS).
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { command } from './core.js';
let picking = false;
export async function chooseDirectory() {
	if (picking) throw new Error('A folder dialog is already open');
	picking = true;
	try {
		let selected;
		if (process.platform === 'darwin')
			selected = await command(
				'/usr/bin/osascript',
				[
					'-e',
					'POSIX path of (choose folder with prompt "Choose a folder for Workbench" default location (path to home folder))'
				],
				{ timeout: 0 }
			);
		else if (process.platform === 'win32')
			selected = await command(
				'powershell.exe',
				[
					'-NoProfile',
					'-STA',
					'-Command',
					'Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.FolderBrowserDialog; $picker.Description = "Choose a folder for Workbench"; if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $picker.SelectedPath }'
				],
				{ timeout: 0 }
			);
		else {
			try {
				selected = await command(
					'zenity',
					['--file-selection', '--directory', '--title=Choose a folder for Workbench'],
					{ timeout: 0 }
				);
			} catch (error) {
				if (error.code === 'ENOENT') return { unavailable: true };
				throw error;
			}
		}
		return selected ? { path: await fs.realpath(selected) } : { cancelled: true };
	} catch (error) {
		if (
			String(error.stderr || error.message).includes('(-128)') ||
			(process.platform === 'linux' && error.code === 1)
		)
			return { cancelled: true };
		throw new Error(`Cannot open the system folder dialog: ${error.stderr || error.message}`);
	} finally {
		picking = false;
	}
}
export async function listDirectories(directory) {
	if (
		directory != null &&
		(typeof directory !== 'string' || directory.length > 4096 || !path.isAbsolute(directory))
	)
		throw new Error('Invalid directory');
	const selected = await fs.realpath(directory || os.homedir());
	const entries = await fs.readdir(selected, { withFileTypes: true });
	const dirs = (
		await Promise.all(
			entries
				.filter((e) => !e.name.startsWith('.'))
				.map(async (e) => {
					if (!e.isDirectory() && !e.isSymbolicLink()) return null;
					const full = path.join(selected, e.name);
					try {
						if (e.isSymbolicLink() && !(await fs.stat(full)).isDirectory()) return null;
						return { name: e.name, path: full };
					} catch {
						return null;
					}
				})
		)
	)
		.filter(Boolean)
		.sort((a, b) => a.name.localeCompare(b.name));
	let repository = false;
	try {
		await fs.stat(path.join(selected, '.git'));
		repository = true;
	} catch {}
	const parent = path.dirname(selected);
	return {
		path: selected,
		parent: parent === selected ? null : parent,
		home: os.homedir(),
		repository,
		directories: dirs
	};
}
