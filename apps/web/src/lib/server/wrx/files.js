/* eslint-disable @typescript-eslint/ban-ts-comment -- verbatim WRX port */
// @ts-nocheck — ported verbatim from WRX (plain JS).
// Read-only workspace file browsing: directory listings, file previews and raw media streaming.
// Every path is resolved (symlinks included) and must stay inside the workspace checkout.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';

const KINDS = {
	image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico'],
	audio: ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus'],
	video: ['mp4', 'webm', 'mov', 'm4v', 'ogv'],
	pdf: ['pdf']
};
const MIME = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	avif: 'image/avif',
	bmp: 'image/bmp',
	ico: 'image/x-icon',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	ogg: 'audio/ogg',
	oga: 'audio/ogg',
	m4a: 'audio/mp4',
	aac: 'audio/aac',
	flac: 'audio/flac',
	opus: 'audio/ogg',
	mp4: 'video/mp4',
	webm: 'video/webm',
	mov: 'video/quicktime',
	m4v: 'video/mp4',
	ogv: 'video/ogg',
	pdf: 'application/pdf'
};
const TEXT_LIMIT = 1024 * 1024;
const LIST_LIMIT = 3000;
const ext = (file) => path.extname(file).slice(1).toLowerCase();
export const fileKind = (file) =>
	Object.keys(KINDS).find((kind) => KINDS[kind].includes(ext(file))) || null;

export function resolveInside(root, rel = '') {
	if (typeof rel !== 'string' || rel.includes('\0')) throw new Error('Invalid path');
	const base = fs.realpathSync(root);
	const target = fs.realpathSync(path.resolve(base, rel.replace(/^\/+/, '')));
	if (target !== base && !target.startsWith(base + path.sep))
		throw new Error('Path is outside the workspace');
	return { base, target, rel: path.relative(base, target).split(path.sep).join('/') };
}

function ignored(cwd, names) {
	if (!names.length) return Promise.resolve(new Set());
	return new Promise((resolve) => {
		const child = spawn('git', ['check-ignore', '--stdin', '-z'], {
			cwd,
			stdio: ['pipe', 'pipe', 'ignore']
		});
		let out = '';
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk) => {
			out += chunk;
		});
		child.on('error', () => resolve(new Set()));
		child.on('close', () => resolve(new Set(out.split('\0').filter(Boolean))));
		child.stdin.on('error', () => {});
		child.stdin.end(names.join('\0') + '\0');
	});
}

export async function listDirectory(root, rel = '') {
	const { base, target, rel: dir } = resolveInside(root, rel);
	if (!fs.statSync(target).isDirectory()) throw new Error('Not a folder');
	const dirents = fs.readdirSync(target, { withFileTypes: true }).filter((d) => d.name !== '.git');
	const entries = [];
	for (const d of dirents.slice(0, LIST_LIMIT)) {
		const full = path.join(target, d.name);
		let stat;
		try {
			stat = fs.statSync(full);
		} catch {
			continue;
		} // broken symlink
		const inside = (() => {
			try {
				return resolveInside(base, path.relative(base, full));
			} catch {
				return null;
			}
		})();
		if (!inside) continue;
		entries.push({
			name: d.name,
			path: dir ? `${dir}/${d.name}` : d.name,
			type: stat.isDirectory() ? 'dir' : 'file',
			size: stat.isDirectory() ? null : stat.size,
			kind: stat.isDirectory() ? null : fileKind(d.name)
		});
	}
	const hidden = await ignored(
		base,
		entries.map((e) => (e.type === 'dir' ? `${e.path}/` : e.path))
	);
	for (const e of entries) if (hidden.has(e.path) || hidden.has(`${e.path}/`)) e.ignored = true;
	entries.sort(
		(a, b) =>
			(a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1) ||
			a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
	);
	return { path: dir, entries, truncated: dirents.length > LIST_LIMIT };
}

export function readFilePreview(root, rel) {
	const { target, rel: file } = resolveInside(root, rel);
	const stat = fs.statSync(target);
	if (!stat.isFile()) throw new Error('Not a file');
	const info = {
		path: file,
		name: path.basename(file),
		size: stat.size,
		modified: stat.mtime.toISOString(),
		kind: fileKind(file)
	};
	if (info.kind) return info;
	const fd = fs.openSync(target, 'r');
	try {
		const buffer = Buffer.alloc(Math.min(stat.size, TEXT_LIMIT));
		fs.readSync(fd, buffer, 0, buffer.length, 0);
		if (buffer.subarray(0, 8000).includes(0)) return { ...info, kind: 'binary' };
		return {
			...info,
			kind: 'text',
			text: buffer.toString('utf8'),
			truncated: stat.size > TEXT_LIMIT
		};
	} finally {
		fs.closeSync(fd);
	}
}

// Streams a workspace file with HTTP range support (media seeking; Safari requires it). Responses are
// sandboxed so a repository's SVG or HTML can never run script on the Workbench origin.
export function serveRaw(request, root, rel) {
	const { target } = resolveInside(root, rel);
	const stat = fs.statSync(target);
	if (!stat.isFile()) throw new Error('Not a file');
	const kind = fileKind(target);
	const headers = {
		'Content-Type': kind ? MIME[ext(target)] : 'application/octet-stream',
		'Accept-Ranges': 'bytes',
		'Cache-Control': 'no-cache',
		'Cross-Origin-Resource-Policy': 'same-origin',
		'X-Content-Type-Options': 'nosniff',
		'Content-Security-Policy': `default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'${kind === 'pdf' ? '' : '; sandbox'}`,
		...(kind
			? {}
			: {
					'Content-Disposition': `attachment; filename="${path.basename(target).replace(/[^\w.-]/g, '_')}"`
				})
	};
	const body = (options) =>
		request.method === 'HEAD' ? null : Readable.toWeb(fs.createReadStream(target, options));
	const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
	if (range && (range[1] || range[2])) {
		let start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
		let end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
		if (start >= stat.size || start > end)
			return new Response(null, {
				status: 416,
				headers: { 'Content-Range': `bytes */${stat.size}` }
			});
		return new Response(body({ start, end }), {
			status: 206,
			headers: {
				...headers,
				'Content-Range': `bytes ${start}-${end}/${stat.size}`,
				'Content-Length': String(end - start + 1)
			}
		});
	}
	return new Response(body(), { headers: { ...headers, 'Content-Length': String(stat.size) } });
}

// Tracked and untracked (not ignored) files whose path contains every query term.
export function searchFiles(root, query) {
	const terms = String(query || '')
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean);
	return gitFiles(root).then((listed) => {
		const files = (listed ?? walkFiles(root)).filter((f) =>
			terms.every((t) => f.toLowerCase().includes(t))
		);
		// Prefer matches in the file name, then shorter paths.
		const score = (f) =>
			(terms.every((t) => path.basename(f).toLowerCase().includes(t)) ? 0 : 1000) + f.length;
		return files
			.sort((a, b) => score(a) - score(b))
			.slice(0, 60)
			.map((f) => ({ path: f, name: path.basename(f), kind: fileKind(f) }));
	});
}

// Git's file list, or null when the folder isn't a repository or Git isn't installed.
function gitFiles(root) {
	return new Promise((resolve) => {
		const child = spawn('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
			cwd: root,
			stdio: ['ignore', 'pipe', 'ignore']
		});
		let out = '';
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk) => {
			if (out.length < 20 * 1024 * 1024) out += chunk;
		});
		child.on('error', () => resolve(null));
		child.on('close', (code) => resolve(code === 0 ? out.split('\0').filter(Boolean) : null));
	});
}

const WALK_LIMIT = 50000;
const WALK_SKIPPED = new Set(['node_modules', '__pycache__']);

// Files under a folder without Git: hidden and dependency folders are left out, and links aren't
// followed, so the walk stays inside the folder.
function walkFiles(root) {
	const files = [];
	const queue = [''];
	for (let next = 0; next < queue.length && files.length < WALK_LIMIT; next++) {
		let entries = [];
		try {
			entries = fs.readdirSync(path.join(root, queue[next]), { withFileTypes: true });
		} catch {
			// An unreadable folder is skipped, like one Git can't list.
		}
		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue;
			const rel = queue[next] ? `${queue[next]}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (!WALK_SKIPPED.has(entry.name)) queue.push(rel);
			} else if (entry.isFile()) files.push(rel);
		}
	}
	return files;
}
