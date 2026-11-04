/* eslint-disable @typescript-eslint/ban-ts-comment, no-empty, no-control-regex, @typescript-eslint/no-unused-expressions -- verbatim WRX port */
// @ts-nocheck — ported from WRX public/app.js (plain JS, string-rendered UI).
// Mounted by routes/(app)/workbench into a `.wrx` element; styles in ./wrx.css.
import { Dictation } from '#lib/components/notes/dictation.js';
import { toast as notify } from '#lib/stores/toast.svelte.js';
import { openSearch } from '#lib/stores/search.svelte.js';

// Drafts and pending images survive navigating away from the workbench during this session.
const drafts = new Map();
const attachments = new Map(); // chatId → [{ name, type, data (base64), url (data: preview) }]

export function mountWrx(root) {
	root.innerHTML = '<div id="app"></div><dialog id="dialog"></dialog>';
	let destroyed = false,
		events = null;
	const listeners = [];
	const on = (target, type, handler, capture) => {
		target.addEventListener(type, handler, capture);
		listeners.push(() => target.removeEventListener(type, handler, capture));
	};
	const $ = (s) => root.querySelector(s);
	const esc = (value) =>
		String(value ?? '').replace(
			/[&<>"']/g,
			(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
		);
	const icons = {
		grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
		branch:
			'<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10m12-10c0 6-12 3-12 10"/>',
		chat: '<path d="M21 11a8 8 0 0 1-8 8H7l-5 3V11a9 9 0 0 1 19 0Z"/>',
		box: '<path d="m12 3 9 5v9l-9 5-9-5V8l9-5Zm0 9L3 8m9 4 9-4m-9 4v10M7 5l9 5"/>',
		check: '<path d="m5 12 4 4L19 6"/>',
		expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
		minimize: '<path d="M3 8h5V3m13 5h-5V3M8 21v-5H3m13 5v-5h5"/>',
		plus: '<path d="M12 5v14M5 12h14"/>',
		arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
		code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/>',
		terminal: '<path d="m4 5 6 6-6 6m9 1h7"/>',
		settings:
			'<circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4M5 5l3 3m8 8 3 3M5 19l3-3m8-8 3-3"/>',
		search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
		chevron: '<path d="m9 6 6 6-6 6"/>',
		folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
		file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
		music:
			'<circle cx="7" cy="17" r="3"/><circle cx="18" cy="15" r="3"/><path d="M10 17V5l11-2v12"/>',
		film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4m10 0h4M3 15h4m10 0h4"/>',
		refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/>',
		image:
			'<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-9 9"/>',
		mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
		trash: '<path d="M4 7h16m-10 4v6m4-6v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>'
	};
	const icon = (name, cls = '') =>
		`<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.grid}</svg>`;
	let state,
		workspaceId = localStorage.getItem('wrx.workspace'),
		chatId = null,
		conversationFullscreen = false,
		tab = 'overview',
		diff = null,
		loading = false;
	const current = () => state?.workspaces.find((w) => w.id === workspaceId);
	const project = () => state?.projects.find((p) => p.id === current()?.projectId);
	const env = () => state?.environments.find((e) => e.id === current()?.environmentId);
	const badge = (text, color = '') => `<span class="badge ${color}"><i></i>${esc(text)}</span>`;
	const btn = (label, action, symbol = 'plus', cls = '') =>
		`<button class="${cls}" data-action="${action}">${icon(symbol)}${label}</button>`;
	async function api(route, body) {
		const res = await fetch(`/api/wrx/${route}`, {
			method: body === undefined ? 'GET' : 'POST',
			headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
			...(body === undefined ? {} : { body: JSON.stringify(body) })
		});
		const data = await res.json().catch(() => ({}));
		if (res.status === 401) {
			location.reload();
			throw new Error('Signed out');
		}
		if (!res.ok) throw new Error(data.error || data.message || 'Request failed');
		return data;
	}
	const toast = (message, tone = 'info') => notify(message, { tone });
	const selecting = () => {
		const sel = getSelection();
		return sel && !sel.isCollapsed && $('#transcript')?.contains(sel.anchorNode);
	};
	async function refresh() {
		state = await api('state');
		if (!current()) workspaceId = state.workspaces[0]?.id;
		if (selecting()) {
			deferred = true;
			return;
		}
		deferred = false;
		render();
	}
	on(document, 'selectionchange', () => {
		if (deferred && !selecting()) {
			deferred = false;
			render();
		}
	});
	function chooseWorkspace(id) {
		stopDictation();
		workspaceId = id;
		chatId = null;
		diff = null;
		tab = 'overview';
		localStorage.setItem('wrx.workspace', id);
		render();
	}
	// Patches the live DOM toward freshly rendered markup instead of replacing it, so scroll position
	// (and in-flight scroll momentum), focus, text selection, images and open <details> survive the
	// frequent refreshes that stream in while agents work.
	function patch(target, html) {
		const next = document.createElement(target.tagName);
		next.innerHTML = html;
		patchChildren(target, next);
	}
	function patchChildren(from, to) {
		const current = [...from.childNodes],
			incoming = [...to.childNodes];
		incoming.forEach((node, i) => {
			const el = current[i];
			if (!el) from.appendChild(node);
			else if (
				el.nodeType !== node.nodeType ||
				el.nodeName !== node.nodeName ||
				(el.nodeType === 1 && el.id !== node.id)
			)
				from.replaceChild(node, el);
			else if (el.nodeType === 1) patchElement(el, node);
			else if (el.nodeValue !== node.nodeValue) el.nodeValue = node.nodeValue;
		});
		for (let i = current.length - 1; i >= incoming.length; i--) current[i].remove();
	}
	function patchElement(el, next) {
		for (const { name } of [...el.attributes])
			if (!next.hasAttribute(name) && name !== 'style') el.removeAttribute(name); // style holds live values such as the mic level
		for (const { name, value } of [...next.attributes])
			if (el.getAttribute(name) !== value) el.setAttribute(name, value);
		if (el.nodeName !== 'TEXTAREA') patchChildren(el, next); // a textarea's live value is managed separately
	}
	function render() {
		if (destroyed) return;
		const w = current(),
			p = project();
		const chats = state.chats.filter((c) => c.workspaceId === w?.id);
		if (tab !== 'agents' || !chats.length) conversationFullscreen = false;
		root.classList.toggle('conversation-fullscreen', conversationFullscreen);
		const active = state.chats.filter((c) => c.status === 'running');
		const filtered = state.projects;
		const old = $('#transcript');
		const stick = !old || old.scrollHeight - old.scrollTop - old.clientHeight < 24;
		patch(
			$('#app'),
			`<aside class="sidebar"><div class="sidebar-top"><span class="eyebrow">YOUR WORKBENCH</span><button class="square" data-action="project" aria-label="Add project">${icon('plus')}</button></div><button class="search" data-action="search" aria-label="Search Corpus">${icon('search')}<span>Search Corpus…</span><kbd>${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'} K</kbd></button><nav><div class="nav-label">PROJECTS <span>${state.projects.length}</span></div>${
				filtered
					.map(
						(p) =>
							`<div class="project-label">${icon('code')}<span>${esc(p.name)}</span><button class="row-delete" data-delete-project="${p.id}" title="Remove project" aria-label="Remove project ${esc(p.name)}">${icon('trash')}</button></div>${state.workspaces
								.filter((x) => x.projectId === p.id)
								.map(
									(x) =>
										`<button class="workspace-link ${w?.id === x.id ? 'selected' : ''}" data-workspace="${x.id}">${icon('branch')}<span>${esc(x.name)}</span>${state.chats.some((c) => c.workspaceId === x.id && c.status === 'running') ? '<i class="live-dot"></i>' : ''}</button>`
								)
								.join('')}`
					)
					.join('') || '<p class="nav-empty">Your projects will appear here.</p>'
			}</nav><div class="sidebar-bottom"><button data-action="environments">${icon('box')}Environments<span>${state.environments.length}</span></button><button data-action="computers">${icon('terminal')}Computers</button><button data-action="settings">${icon('settings')}Connections<span class="live-dot"></span></button><div class="user"><span class="avatar">${icon('terminal')}</span><div>Local workbench<small>On your machine. In your control.</small></div></div></div></aside><section class="wrx-main"><header><div class="breadcrumbs">Workbench${p ? ` ${icon('chevron')} <span>${esc(p.name)}</span> ${icon('chevron')} <strong>${esc(w.name)}</strong>` : ''}</div><div class="header-right">${((n) => badge(`${n} agent${n === 1 ? '' : 's'} running`, n ? 'green' : ''))(active.reduce((s, c) => s + c.members.filter((m) => m.status === 'running').length, 0))}<button class="machine-button" data-action="computers">${icon('terminal')} ${esc(state.machine?.name || 'This computer')}${state.remote ? ' · Remote' : ''}</button></div></header>${
				!w
					? welcome()
					: `<section class="workspace-header"><div><div class="eyebrow">PROJECT WORKSPACE</div><h1>${esc(w.name)}<span class="workspace-tag">${icon('branch')}${esc(w.branch)}</span></h1><p>${esc(p.path)}</p></div><div class="actions">${btn('New workspace', 'workspace', 'branch')}${btn('New agent', 'chat', 'plus', 'primary')}</div></section><div class="tabs">${[
							['overview', 'grid', 'Overview'],
							['agents', 'chat', 'Agent chats'],
							['changes', 'code', 'Changes'],
							['files', 'folder', 'Files'],
							['tasks', 'check', 'Tasks'],
							['runtime', 'box', 'Environment']
						]
							.map(
								([id, ico, label]) =>
									`<button class="${tab === id ? 'active' : ''}" data-tab="${id}">${icon(ico)}${label}${id === 'agents' && chats.length ? `<span class="count">${chats.length}</span>` : ''}</button>`
							)
							.join(
								''
							)}</div><div class="content">${tab === 'overview' ? overview(chats) : tab === 'agents' ? agentView(chats) : tab === 'changes' ? changes() : tab === 'files' ? filesView() : tab === 'tasks' ? tasksView() : runtimeView()}</div>`
			}<footer><span><i class="live-dot"></i> Corpus / developer workbench</span><span>${esc(state.machine?.name || 'LOCAL FIRST')} <span class="footer-divider">/</span> v0.1.0</span></footer></section>`
		);
		const box = $('#message');
		if (box && box.value !== (drafts.get(chatId) || '')) box.value = drafts.get(chatId) || '';
		// Follow new output only when already at the bottom; otherwise leave the reader where they are.
		const t = $('#transcript');
		if (t) {
			if (stick || renderedChat !== chatId) t.scrollTop = t.scrollHeight;
			renderedChat = chatId;
			$('.jump')?.classList.toggle('hidden', t.scrollHeight - t.scrollTop - t.clientHeight < 80);
		} else renderedChat = null;
	}
	function welcome() {
		return `<div class="welcome"><span class="hero-icon">${icon('branch')}</span><div class="eyebrow">A PLACE TO GET WORK DONE</div><h1>Your next branch.<br>Your next breakthrough.</h1><p>Bring your repository. Give every task its own workspace,<br>the right agent, and an environment that fits.</p>${btn('Open a local repository', 'project', 'plus', 'primary large')}<div class="welcome-features"><div>${icon('branch')}<b>Room to experiment</b><span>Real Git worktrees. Separate branches.</span></div><div>${icon('chat')}<b>Think, build, review</b><span>Claude and Codex, with context.</span></div><div>${icon('box')}<b>Dependencies, contained</b><span>Shared runtimes or dedicated VMs.</span></div></div><small>No projects yet. Start with an existing Git repository.</small></div>`;
	}
	function overview(chats) {
		const w = current(),
			e = env(),
			tasks = state.tasks.filter((t) => t.workspaceId === w.id);
		const active = chats.filter((c) => c.status === 'running').length;
		return `<div class="overview-top"><div><h2>A little focus goes a long way.</h2><p>Your code, conversations, and services. One workspace.</p></div><span class="mono muted">${esc(new Date(w.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }))}</span></div><div class="stats"><div>${icon('chat')}<span>Agent conversations</span><strong>${chats.length}<small>${active ? `${active} running` : 'Ready when you are'}</small></strong></div><div>${icon('branch')}<span>Working branch</span><strong class="branch-name">${esc(w.branch)}<small>Independent Git checkout</small></strong></div><div>${icon('box')}<span>Dependency environment</span><strong>${e ? esc(e.scope === 'shared' ? 'Shared VM' : 'Isolated VM') : 'Not attached'}<small>${e ? esc(e.name) : 'Choose the right amount of isolation'}</small></strong></div></div><div class="two-columns"><section class="panel"><div class="panel-heading"><h3>${icon('chat')}Agent conversations</h3><button class="text-button" data-action="chat">New chat ${icon('plus')}</button></div>${
			chats.length
				? `<div class="chat-rows">${chats
						.slice()
						.reverse()
						.slice(0, 5)
						.map(
							(c) =>
								`<button class="chat-row" data-chat="${c.id}"><span class="avatar-stack">${c.members.slice(0, 3).map(avatar).join('')}</span><div><b>${esc(c.title)}</b><small>${c.members.map((m) => `@${esc(m.handle)}`).join(' ')}</small></div>${badge(c.status, c.status === 'running' ? 'green' : '')}${icon('chevron')}</button>`
						)
						.join('')}</div>`
				: `<div class="empty compact">${icon('chat')}<h3>A second pair of eyes.</h3><p>Spin up a team of agents — lead, designer, engineer,<br>marketing — and let them work it out together.</p>${btn('Start a conversation', 'chat')}</div>`
		}</section><section class="panel"><div class="panel-heading"><h3>${icon('box')}Workspace environment</h3>${badge(e?.status || 'Unconfigured', e?.status === 'running' ? 'green' : '')}</div><div class="environment-summary"><div class="environment-art">${icon('box')}<span>${e ? e.scope.toUpperCase() : 'YOUR RUNTIME'}</span></div><h3>${e ? esc(e.name) : 'Keep dependencies in their place.'}</h3><p>${e ? `${e.cpus} CPUs · ${e.memory} GB memory · ${e.disk} GB disk` : 'Reuse a shared VM for speed, or give this<br>workspace a dedicated VM for isolation.'}</p>${btn(e ? 'Manage environment' : 'Attach an environment', e ? 'runtime-view' : 'environment', 'arrow')}</div></section></div><section class="panel next-panel"><div><span class="eyebrow">MAKE PROGRESS</span><h3>${tasks.length ? `${tasks.filter((t) => t.status === 'done').length} of ${tasks.length} tasks complete` : 'Big ideas, manageable steps.'}</h3><p>Keep a lightweight task list alongside the work.</p></div>${btn('Open task list', 'tasks', 'arrow')}</section><div class="workspace-location">${icon('terminal')}<span>${esc(w.path)}</span><button class="text-button" data-action="copy-path">Copy path</button></div>`;
	}
	const PRESETS = [
		{
			key: 'lead',
			name: 'Lead',
			mode: 'assess',
			role: "You lead this thread. Turn the human's goal into a plan, delegate pieces to the right teammate by @mention, resolve disagreements, and summarize decisions and next steps for @you."
		},
		{
			key: 'engineer',
			name: 'Engineer',
			mode: 'implement',
			role: 'You own technical design and implementation. Inspect the codebase, propose the simplest sound approach, build it, and validate it.'
		},
		{
			key: 'designer',
			name: 'Designer',
			mode: 'assess',
			role: 'You own product, UX and visual design: user flows, layout, interaction states, copy hierarchy and accessibility. Give concrete, buildable recommendations.'
		},
		{
			key: 'marketing',
			name: 'Marketing',
			mode: 'assess',
			role: 'You own positioning, audience, messaging and launch. Tie features to user value and suggest channels, hooks and measurable goals.'
		},
		{
			key: 'comms',
			name: 'Comms',
			mode: 'assess',
			role: 'You turn decisions into clear writing: announcements, release notes, docs, emails and summaries. Match tone to the audience; be brief and precise.'
		},
		{
			key: 'reviewer',
			name: 'Reviewer',
			mode: 'review',
			role: 'You are the critical reviewer. Find bugs, risks, gaps, unclear requirements and weak arguments. Be specific and prioritize.'
		},
		{
			key: 'researcher',
			name: 'Researcher',
			mode: 'assess',
			role: 'You investigate questions in depth: read the code, compare options and report evidence-backed findings with file references.'
		},
		{ key: 'custom', name: '', mode: 'assess', role: '' }
	];
	const MODE_LABELS = { assess: 'Assess', implement: 'Implement', review: 'Review' };
	const SLASH = [
		['/add', 'Add an agent to this thread', '[role]'],
		['/new', 'Start a new thread'],
		['/stop', 'Stop running agents and clear the queue'],
		['/lead', 'Make an agent the thread lead', '@agent']
	];
	const openKeys = new Set();
	let menu = null,
		mentionColors = {},
		renderedChat = null,
		deferred = false;
	const member = (chat, memberId) => chat?.members.find((m) => m.id === memberId);
	const avatar = (m) =>
		`<span class="avatar-chip c${m.color ?? 0}">${esc((m.name || '?')[0].toUpperCase())}</span>`;
	const time = (at) =>
		esc(new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
	const money = (usd) => (usd >= 0.01 ? `$${usd.toFixed(2)}` : usd ? `$${usd.toFixed(4)}` : '');
	const seconds = (ms) =>
		ms >= 60000
			? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
			: `${(ms / 1000).toFixed(1)}s`;
	// Safe Markdown subset: everything is escaped first; only known constructs become markup.
	function md(src) {
		const blocks = [];
		const text = String(src ?? '').replace(
			/```([\w+-]*)[^\n]*\n?([\s\S]*?)(?:```|$)/g,
			(_, lang, code) => {
				blocks.push(
					`<pre class="md-code">${lang ? `<span class="md-lang">${esc(lang)}</span>` : ''}<code>${esc(code.replace(/\n$/, ''))}</code></pre>`
				);
				return `\n\u0000${blocks.length - 1}\u0000\n`;
			}
		);
		const inline = (t) => {
			const codes = [];
			t = t.replace(/`([^`\n]+)`/g, (_, c) => {
				codes.push(`<code>${esc(c)}</code>`);
				return `\u0001${codes.length - 1}\u0001`;
			});
			return esc(t)
				.replace(
					/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
					'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
				)
				.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
				.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
				.replace(
					/(^|[^\w@/.`])@([a-z0-9][\w-]*)/gi,
					(_, pre, h) =>
						`${pre}<span class="mention ${mentionColors[h.toLowerCase()] || ''}">@${h}</span>`
				)
				.replace(/\u0001(\d+)\u0001/g, (_, i) => codes[i]);
		};
		const lines = text.split('\n');
		const out = [];
		let i = 0;
		const bullet = /^\s*[-*+]\s+/,
			numbered = /^\s*\d+[.)]\s+/,
			starts = (l) =>
				/^#{1,6}\s/.test(l) ||
				bullet.test(l) ||
				numbered.test(l) ||
				/^>/.test(l) ||
				/^\u0000\d+\u0000$/.test(l.trim()) ||
				/^\s*\|/.test(l);
		while (i < lines.length) {
			const line = lines[i];
			let m;
			if (!line.trim()) {
				i++;
				continue;
			}
			if ((m = line.trim().match(/^\u0000(\d+)\u0000$/))) {
				out.push(blocks[m[1]]);
				i++;
				continue;
			}
			if ((m = line.match(/^(#{1,6})\s+(.*)/))) {
				const n = Math.min(m[1].length + 2, 6);
				out.push(`<h${n}>${inline(m[2])}</h${n}>`);
				i++;
				continue;
			}
			if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
				out.push('<hr>');
				i++;
				continue;
			}
			if (bullet.test(line) || numbered.test(line)) {
				const pattern = bullet.test(line) ? bullet : numbered;
				const items = [];
				while (
					i < lines.length &&
					(pattern.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))
				) {
					if (pattern.test(lines[i])) items.push(lines[i].replace(pattern, ''));
					else items[items.length - 1] += ` ${lines[i].trim()}`;
					i++;
				}
				const tag = pattern === bullet ? 'ul' : 'ol';
				out.push(
					`<${tag}>${items
						.map((x) => {
							const box = x.match(/^\[( |x)\]\s*/i);
							return `<li${box ? ` class="task ${box[1] === ' ' ? '' : 'checked'}"` : ''}>${inline(box ? x.slice(box[0].length) : x)}</li>`;
						})
						.join('')}</${tag}>`
				);
				continue;
			}
			if (/^>/.test(line)) {
				const q = [];
				while (i < lines.length && /^>/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''));
				out.push(`<blockquote>${q.map(inline).join('<br>')}</blockquote>`);
				continue;
			}
			if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
				const cells = (l) =>
					l
						.trim()
						.replace(/^\||\|$/g, '')
						.split('|')
						.map((c) => inline(c.trim()));
				const head = cells(line);
				i += 2;
				const rows = [];
				while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
				out.push(
					`<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
				);
				continue;
			}
			const para = [];
			while (i < lines.length && lines[i].trim() && (!para.length || !starts(lines[i])))
				para.push(lines[i++]);
			out.push(`<p>${para.map(inline).join('<br>')}</p>`);
		}
		return `<div class="md">${out.join('')}</div>`;
	}
	function toolView(msg, block, index) {
		const key = `${msg.id}:${index}`;
		const diff =
			block.detail &&
			/^[-+]/.test(block.detail) &&
			['Edit', 'MultiEdit', 'Write'].includes(block.name);
		return `<details class="tool ${esc(block.status)}" data-open="${key}" ${openKeys.has(key) ? 'open' : ''}><summary><i class="tool-state"></i><b>${esc(block.name)}</b><span>${esc(block.summary)}</span></summary>${
			block.detail
				? `<pre class="tool-detail">${
						diff
							? block.detail
									.split('\n')
									.map(
										(l) =>
											`<span class="${l[0] === '+' ? 'added' : l[0] === '-' ? 'removed' : ''}">${esc(l)}</span>`
									)
									.join('\n')
							: esc(block.detail)
					}</pre>`
				: ''
		}${block.result ? `<pre class="tool-result">${esc(block.result)}</pre>` : ''}${!block.detail && !block.result ? `<p class="tool-empty">${block.status === 'running' ? 'Running…' : 'No output.'}</p>` : ''}</details>`;
	}
	const imagesView = (chat, m) =>
		m.images?.length
			? `<div class="message-images ${m.role === 'agent' ? 'generated' : ''}">${m.images.map((i) => `<a href="/api/wrx/uploads/${esc(chat.id)}/${esc(i.file)}" target="_blank" rel="noopener noreferrer" title="${esc(i.name)}"><img src="/api/wrx/uploads/${esc(chat.id)}/${esc(i.file)}" alt="${esc(i.name)}" loading="lazy"></a>`).join('')}</div>`
			: '';
	// Rendered message HTML, reused across refreshes while nothing it depends on changed. A
	// streaming run refreshes several times a second; without this every message in the
	// transcript re-ran Markdown/escaping each time, so cost grew with the conversation.
	const messageCache = new Map();
	const chatSigs = new WeakMap();
	function messageView(chat, m) {
		let chatSig = chatSigs.get(chat);
		if (chatSig === undefined) {
			chatSig = JSON.stringify([chat.id, chat.members, mentionColors]);
			chatSigs.set(chat, chatSig);
		}
		const prefix = `${m.id}:`;
		const open = [...openKeys].filter((k) => k.startsWith(prefix)).join(',');
		const sig = `${chatSig}|${open}|${JSON.stringify(m)}`;
		const key = `${chat.id}:${m.id}`;
		const hit = messageCache.get(key);
		if (hit && hit.sig === sig) return hit.html;
		const html = renderMessage(chat, m);
		if (messageCache.size > 5000) messageCache.clear();
		messageCache.set(key, { sig, html });
		return html;
	}
	function renderMessage(chat, m) {
		if (m.role === 'system')
			return `<div class="system-note"><span>${esc(m.text)}</span><small>${time(m.at)}</small></div>`;
		const actions = `<div class="message-actions"><button class="ghost" data-copy-message="${esc(m.id)}" title="Copy message" aria-label="Copy message">⧉</button>${m.role === 'agent' && member(chat, m.memberId) ? `<button class="ghost" data-reply="${esc(member(chat, m.memberId).handle)}" title="Reply to this agent" aria-label="Reply to this agent">↩</button>` : ''}</div>`;
		if (m.role === 'user')
			return `<article class="message user"><span class="avatar-chip you">Y</span><div class="message-body"><div class="message-meta"><b>YOU</b><span>${time(m.at)}</span></div>${m.text ? md(m.text) : ''}${imagesView(chat, m)}</div>${actions}</article>`;
		const a = member(chat, m.memberId) || {
			name: 'Former agent',
			handle: 'agent',
			color: 7,
			provider: '',
			mode: ''
		};
		const blocks = m.blocks
			? m.blocks
					.map((b, i) =>
						b.kind === 'text'
							? md(b.text)
							: b.kind === 'thinking'
								? `<details class="thinking" data-open="${m.id}:${i}" ${openKeys.has(`${m.id}:${i}`) ? 'open' : ''}><summary>Thought process</summary><div>${esc(b.text)}</div></details>`
								: toolView(m, b, i)
					)
					.join('')
			: md(m.text);
		const footer = [
			m.status === 'cancelled' && 'Stopped',
			m.status === 'interrupted' && 'Interrupted',
			m.status !== 'running' && m.durationMs && seconds(m.durationMs),
			money(m.costUsd)
		]
			.filter(Boolean)
			.join(' · ');
		return `<article class="message agent ${m.status === 'running' ? 'live' : ''}">${avatar(a)}<div class="message-body"><div class="message-meta"><b class="name c${a.color ?? 0}">${esc(a.name)}</b><span class="handle">@${esc(a.handle)}</span>${a.provider ? `<span class="tag">${esc(a.provider)} · ${esc(MODE_LABELS[a.mode] || a.mode)}</span>` : ''}<span>${time(m.at)}</span>${m.by && m.by !== 'you' ? `<span class="via">via @${esc(m.by)}</span>` : ''}</div>${blocks}${imagesView(chat, m)}${m.status === 'running' && !m.blocks?.length ? '<div class="typing"><i></i><i></i><i></i></div>' : ''}${m.error ? `<pre class="error">${esc(m.error)}</pre>` : ''}${m.diagnostics && m.status === 'failed' ? `<details class="thinking"><summary>Provider diagnostics</summary><div>${esc(m.diagnostics)}</div></details>` : ''}${footer ? `<div class="message-footer">${esc(footer)}</div>` : ''}</div>${actions}</article>`;
	}
	function recipients(chat, text) {
		const handles = [
			...String(text)
				.replace(/```[\s\S]*?```/g, ' ')
				.replace(/`[^`\n]*`/g, ' ')
				.matchAll(/(^|[^\w@/.`])@([a-z0-9][\w-]*)/gi)
		].map((x) => x[2].replace(/[-_]+$/, '').toLowerCase());
		const named = handles.some((h) => ['all', 'here', 'channel', 'everyone'].includes(h))
			? chat.members
			: chat.members.filter((m) => handles.includes(m.handle));
		return named.length ? named : [member(chat, chat.leadId) || chat.members[0]];
	}
	function todoBar(chat) {
		const latest = chat.messages.findLast((m) => m.role === 'agent' && m.todos?.length);
		if (!latest || latest.todos.every((t) => t.status === 'completed')) return '';
		const done = latest.todos.filter((t) => t.status === 'completed').length;
		const a = member(chat, latest.memberId);
		return `<details class="todo-bar" data-open="todos:${latest.id}" ${openKeys.has(`todos:${latest.id}`) ? 'open' : ''}><summary>☑ ${esc(a?.name || 'Agent')} todos <span>${done}/${latest.todos.length}</span><em>${esc(latest.todos.find((t) => t.status === 'in_progress')?.activeForm || latest.todos.find((t) => t.status === 'in_progress')?.content || '')}</em></summary><ul>${latest.todos.map((t) => `<li class="${esc(t.status)}">${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◉' : '○'} ${esc(t.content)}</li>`).join('')}</ul></details>`;
	}
	function menuView() {
		if (!menu?.items.length) return '';
		return `<div class="composer-menu" role="listbox">${menu.items.map((item, i) => `<button type="button" class="${i === menu.index ? 'active' : ''}" data-menu="${i}" role="option" aria-selected="${i === menu.index}">${item.chip || ''}<b>${esc(item.label)}</b>${item.hint ? `<i>${esc(item.hint)}</i>` : ''}<span>${esc(item.description)}</span></button>`).join('')}</div>`;
	}
	// ─── Image attachments: drop onto the conversation, paste, or pick ──────────
	const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
	const attachmentsView = (id) =>
		(attachments.get(id) || [])
			.map(
				(a, i) =>
					`<span class="attachment" title="${esc(a.name)}"><img src="${a.url}" alt=""><span>${esc(a.name)}</span><button type="button" class="ghost" data-remove-attachment="${i}" aria-label="Remove ${esc(a.name)}">×</button></span>`
			)
			.join('');
	function showAttachments() {
		const el = $('#attachments');
		if (el) {
			el.innerHTML = attachmentsView(chatId);
			el.hidden = !attachments.get(chatId)?.length;
		}
	}
	async function addImages(files) {
		const id = chatId;
		if (!id) return;
		const list = attachments.get(id) || [];
		for (const file of files) {
			if (!IMAGE_MIME.includes(file.type)) {
				toast(`${file.name || 'That file'} isn't a PNG, JPEG, GIF or WebP image`);
				continue;
			}
			if (file.size > 5 * 1024 * 1024) {
				toast(`${file.name} is larger than 5 MB`);
				continue;
			}
			if (list.length >= 6) {
				toast('Attach up to 6 images per message');
				break;
			}
			const url = await new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(reader.result);
				reader.onerror = () => reject(reader.error);
				reader.readAsDataURL(file);
			});
			list.push({
				name: file.name || `pasted-image-${list.length + 1}.${file.type.split('/')[1]}`,
				type: file.type,
				data: url.slice(url.indexOf(',') + 1),
				url
			});
		}
		attachments.set(id, list);
		showAttachments();
		$('#message')?.focus();
	}

	// ─── Voice input (ported from Corpus) ───────────────────────────────────────
	// sherpa-onnx streaming Zipformer in a worker (public/asr-worker.js), fed from the mic through an
	// AudioWorklet. Runs offline in any modern browser on any OS; the model comes from `npm run models`
	// and is kept in the Cache API after the first load. Keep ASR_VERSION in sync with that script.
	const voice = { session: null, status: 'idle', partial: '', progress: 0 };
	const micTitle = () =>
		({
			idle: 'Voice input (⌥M)',
			loading: 'Loading speech model… click to cancel',
			listening: 'Stop voice input (⌥M or Esc)',
			stopping: 'Finishing…'
		})[voice.status];
	const dictationText = () =>
		voice.status === 'loading'
			? `Loading speech model${voice.progress ? ` · ${Math.round(voice.progress * 100)}%` : '…'}${voice.progress && voice.progress < 1 ? ' (first use only)' : ''}`
			: voice.status === 'stopping'
				? 'Finishing…'
				: voice.partial || 'Listening… speak naturally';
	function showDictation() {
		const mic = $('#mic');
		if (mic) {
			mic.className = `ib mic ${voice.status}`;
			mic.title = micTitle();
			mic.setAttribute('aria-pressed', String(voice.status === 'listening'));
		}
		const status = $('#dictation-status');
		if (status) {
			status.hidden = voice.status === 'idle';
			status.querySelector('span').textContent = dictationText();
			status.classList.toggle('partial', !!voice.partial);
		}
	}
	// Inserts a final phrase at the caret with sentence-aware spacing and capitalization.
	function insertSpeech(text) {
		const box = $('#message');
		if (!box || !text) return;
		const start = box.selectionStart ?? box.value.length,
			end = box.selectionEnd ?? start;
		const before = box.value.slice(0, start);
		const phrase = /(^|[.!?])$/.test(before.trimEnd())
			? text[0].toUpperCase() + text.slice(1)
			: text;
		const insert = (before && !/\s$/.test(before) ? ' ' : '') + phrase;
		box.value = before + insert + box.value.slice(end);
		box.setSelectionRange(start + insert.length, start + insert.length);
		drafts.set(chatId, box.value);
		updateMenu();
	}
	async function toggleDictation() {
		if (voice.session) return voice.session.stop();
		if (
			!navigator.mediaDevices?.getUserMedia ||
			typeof AudioWorkletNode === 'undefined' ||
			typeof WebAssembly === 'undefined'
		)
			return toast('Voice input needs a modern browser and a secure page (localhost or HTTPS).');
		const session = new Dictation({
			onstatus: (s) => {
				voice.status = s;
				if (s === 'idle' && voice.session === session) voice.session = null;
				showDictation();
			},
			onpartial: (t) => {
				voice.partial = t;
				showDictation();
			},
			onresult: insertSpeech,
			onprogress: (f) => {
				voice.progress = f;
				showDictation();
			},
			onlevel: (l) => $('#mic')?.style.setProperty('--level', l.toFixed(2)),
			onerror: (message) => toast(message, 'error')
		});
		voice.session = session;
		voice.progress = 0;
		$('#message')?.focus();
		await session.start();
	}
	const stopDictation = () => voice.session?.stop();
	function agentView(chats) {
		let chat = chats.find((c) => c.id === chatId);
		if (!chat && chats.length) {
			chat = chats.at(-1);
			chatId = chat.id;
		}
		mentionColors = {
			you: 'you',
			all: 'all',
			here: 'all',
			channel: 'all',
			everyone: 'all',
			...Object.fromEntries((chat?.members || []).map((m) => [m.handle, `c${m.color ?? 0}`]))
		};
		const working = chat?.members.filter((m) => m.status === 'running') || [];
		const running = working[0];
		const queued = chat?.members.filter((m) => m.status === 'queued') || [];
		const list = chats
			.slice()
			.reverse()
			.map((c) => {
				const lives = c.members.filter((m) => m.status === 'running');
				const live = lives[0];
				const last = c.messages.findLast((m) => m.role !== 'system' && m.text);
				return `<div class="conversation-row"><button class="conversation ${chat?.id === c.id ? 'selected' : ''}" data-chat="${c.id}"><span class="conversation-title">${live ? '<i class="live-dot"></i>' : ''}${esc(c.title)}</span><span class="avatar-stack">${c.members.slice(0, 5).map(avatar).join('')}${c.members.length > 5 ? `<small>+${c.members.length - 5}</small>` : ''}</span><small>${live ? `${lives.map((m) => `@${esc(m.handle)}`).join(', ')} ${lives.length > 1 ? 'are' : 'is'} working…` : c.status === 'queued' ? 'Queued' : last ? esc(`${last.role === 'user' ? 'You' : member(c, last.memberId)?.name || 'Agent'}: ${last.text.replace(/\s+/g, ' ').slice(0, 60)}`) : `${c.members.length} agent${c.members.length === 1 ? '' : 's'} · ${esc(c.status)}`}</small></button><button class="row-delete" data-delete-chat="${c.id}" title="Delete conversation" aria-label="Delete conversation ${esc(c.title)}">${icon('trash')}</button></div>`;
			})
			.join('');
		const draft = drafts.get(chatId) || '';
		return `<div class="agent-layout"><div class="conversation-list"><div class="panel-heading"><h3>Conversations</h3><button class="square" data-action="chat" aria-label="New conversation">${icon('plus')}</button></div>${list || '<p class="muted inset">Start a thread to begin.</p>'}</div><section class="conversation-main">${chat ? `<div class="chat-heading"><div class="chat-title"><h3>${esc(chat.title)}</h3><small>${chat.members.length} agent${chat.members.length === 1 ? '' : 's'} · ${esc(running ? 'working' : chat.status)}${chat.members.some((m) => m.costUsd) ? ` · ${money(chat.members.reduce((s, m) => s + (m.costUsd || 0), 0))}` : ''}</small></div><div class="roster">${chat.members.map((m) => `<button class="member ${m.status}" data-member="${m.id}" title="${esc(`${m.name} (@${m.handle}) · ${m.provider} / ${MODE_LABELS[m.mode]}${m.role ? `\n${m.role}` : ''}`)}">${avatar(m)}<span>${esc(m.name)}</span>${m.id === chat.leadId ? '<em title="Thread lead">★</em>' : ''}<i class="member-state"></i></button>`).join('')}${btn('Add agent', 'add-member', 'plus')}<button data-action="conversation-fullscreen" aria-label="${conversationFullscreen ? 'Minimize conversation' : 'Expand conversation to full screen'}" aria-pressed="${conversationFullscreen}" title="${conversationFullscreen ? 'Return to normal view' : 'Full screen'}">${icon(conversationFullscreen ? 'minimize' : 'expand')}<span>${conversationFullscreen ? 'Minimize' : 'Full screen'}</span></button>${running || queued.length ? btn('Stop', 'cancel', 'check') : ''}</div></div><div id="transcript" class="transcript">${!chat.messages.length ? `<div class="empty thread-welcome"><span class="logo">✻</span><h3>What should the team work on?</h3><p>Messages go to the thread lead, <b>@${esc(member(chat, chat.leadId)?.handle || '')}</b>, unless you @mention someone.<br>Agents hand work to each other with @mentions. Read-only agents work in parallel; agents that edit files take turns.</p><div class="tips"><span><kbd>@</kbd> mention an agent</span><span><kbd>@all</kbd> everyone</span><span><kbd>/</kbd> commands</span><span><kbd>Esc</kbd> stop</span></div></div>` : chat.messages.map((m) => messageView(chat, m)).join('')}${running ? `<div class="working"><span class="spark">✻</span>${working.map((m) => `<b>${esc(m.name)}</b>`).join(', ')} ${working.length > 1 ? 'are' : 'is'} working…${queued.length ? ` <span>Up next: ${queued.map((m) => `@${esc(m.handle)}`).join(', ')}</span>` : ''}<span class="esc">esc to stop</span></div>` : queued.length ? `<div class="working"><i class="live-dot"></i> Waiting for the workspace · up next: ${queued.map((m) => `@${esc(m.handle)}`).join(', ')}</div>` : ''}${chat.events.length ? `<details class="activity-log" data-open="events:${chat.id}" ${openKeys.has(`events:${chat.id}`) ? 'open' : ''}><summary>Activity & diagnostics (${chat.events.length})</summary><pre class="activity">${esc(chat.events.join('\n'))}</pre></details>` : ''}</div><button class="jump hidden" data-action="jump" aria-label="Scroll to latest">↓</button>${todoBar(chat)}<form id="message-form" class="composer"><div id="composer-menu">${menuView()}</div><div id="attachments" class="attachments" ${attachments.get(chatId)?.length ? '' : 'hidden'}>${attachmentsView(chatId)}</div><div id="dictation-status" class="dictation-status ${voice.partial ? 'partial' : ''}" ${voice.status === 'idle' ? 'hidden' : ''} aria-live="polite"><i></i><span>${esc(dictationText())}</span></div><textarea id="message" name="message" placeholder="Message ${esc(chat.title)} — @mention agents, / for commands" rows="3" aria-label="Message to agents"></textarea><div class="composer-bar"><div class="composer-left"><button type="button" class="ib" data-action="mention" title="Mention an agent" aria-label="Mention an agent">@</button><button type="button" class="ib" data-action="slash" title="Commands" aria-label="Commands">/</button><button type="button" class="ib" data-action="attach" title="Attach images — or drop / paste them" aria-label="Attach images">${icon('image')}</button><input type="file" id="image-input" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden><button type="button" id="mic" class="ib mic ${voice.status}" data-action="dictate" title="${micTitle()}" aria-label="Voice input" aria-pressed="${voice.status === 'listening'}">${icon('mic')}</button><span id="recipients" class="recipients">${recipientsLabel(chat, draft)}</span></div><div class="composer-right"><small>Enter to send · ⇧Enter for a new line</small><button class="primary" aria-label="Send">Send ${icon('arrow')}</button></div></div></form>` : `<div class="empty"><h3>Your team is ready.</h3><p>Start a thread with one or more agents — a lead, designer, engineer, marketer…</p>${btn('New conversation', 'chat', 'plus', 'primary')}</div>`}</section></div>`;
	}
	const recipientsLabel = (chat, text) =>
		`→ ${recipients(chat, text)
			.map((m) => `<span class="mention c${m.color ?? 0}">@${esc(m.handle)}</span>`)
			.join(' ')}`;
	function updateMenu() {
		const box = $('#message');
		const chat = state.chats.find((c) => c.id === chatId);
		if (!box || !chat) return;
		const before = box.value.slice(0, box.selectionStart);
		let match;
		if ((match = before.match(/(^|\s)@([\w-]*)$/))) {
			const q = match[2].toLowerCase();
			const items = [
				...chat.members.map((m) => ({
					value: m.handle,
					label: `@${m.handle}`,
					description: `${m.name} · ${m.provider} / ${MODE_LABELS[m.mode]}`,
					chip: avatar(m)
				})),
				{ value: 'all', label: '@all', description: 'Every agent in this thread replies in turn' }
			].filter((x) => x.value.includes(q) || x.description.toLowerCase().includes(q));
			menu = {
				type: 'mention',
				start: before.length - q.length - 1,
				end: box.selectionStart,
				items: items.slice(0, 8),
				index: Math.min(menu?.type === 'mention' ? menu.index : 0, Math.max(0, items.length - 1))
			};
		} else if ((match = box.value.match(/^\/(\w*)$/))) {
			const items = SLASH.filter(([name]) => name.startsWith(`/${match[1]}`)).map(
				([name, description, hint]) => ({ value: name, label: name, description, hint })
			);
			menu = {
				type: 'slash',
				items,
				index: Math.min(menu?.type === 'slash' ? menu.index : 0, Math.max(0, items.length - 1))
			};
		} else menu = null;
		$('#composer-menu').innerHTML = menuView();
		$('#recipients').innerHTML = recipientsLabel(chat, box.value);
	}
	function applyMenu(index = menu?.index ?? 0) {
		const box = $('#message');
		const item = menu?.items[index];
		if (!box || !item) return;
		if (menu.type === 'mention') {
			box.value = `${box.value.slice(0, menu.start)}@${item.value} ${box.value.slice(menu.end)}`;
			const caret = menu.start + item.value.length + 2;
			box.setSelectionRange(caret, caret);
		} else box.value = `${item.value} `;
		drafts.set(chatId, box.value);
		box.focus();
		menu = null;
		updateMenu();
	}
	function insertText(text) {
		const box = $('#message');
		if (!box) return;
		const start = box.selectionStart ?? box.value.length;
		const prefix = start && !/\s$/.test(box.value.slice(0, start)) ? ' ' : '';
		box.value =
			box.value.slice(0, start) + prefix + text + box.value.slice(box.selectionEnd ?? start);
		const caret = start + prefix.length + text.length;
		box.focus();
		box.setSelectionRange(caret, caret);
		drafts.set(chatId, box.value);
		updateMenu();
	}
	async function slashCommand(text) {
		const [name, ...rest] = text.trim().split(/\s+/);
		const arg = rest.join(' ').replace(/^@/, '').toLowerCase();
		const chat = state.chats.find((c) => c.id === chatId);
		if (name === '/add') {
			memberDialog(PRESETS.find((p) => p.key === arg || p.name.toLowerCase() === arg)?.key);
			return true;
		}
		if (name === '/new') {
			newChat();
			return true;
		}
		if (name === '/stop') {
			await api('cancel', { chatId });
			await refresh();
			return true;
		}
		if (name === '/lead') {
			const m = chat.members.find((x) => x.handle === arg);
			if (!m) throw new Error('Usage: /lead @agent');
			await api('member', { chatId, memberId: m.id, lead: true });
			await refresh();
			toast(`@${m.handle} now leads this thread`);
			return true;
		}
		return false;
	}
	function presetOptions(selected) {
		return PRESETS.map(
			(p) =>
				`<option value="${p.key}" ${p.key === selected ? 'selected' : ''}>${p.key === 'custom' ? 'Custom…' : esc(p.name)}</option>`
		).join('');
	}
	const providerOptions = (selected = 'claude') =>
		`<option value="claude" ${selected === 'claude' ? 'selected' : ''}>Claude Code</option><option value="codex" ${selected === 'codex' ? 'selected' : ''}>Codex</option>`;
	const modeOptions = (selected) =>
		Object.entries({
			assess: 'Assess — advise and plan (read-only)',
			implement: 'Implement — edit and validate',
			review: 'Review — inspect and find issues'
		})
			.map(([v, l]) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${l}</option>`)
			.join('');
	function memberDialog(presetKey = 'designer') {
		const chat = state.chats.find((c) => c.id === chatId);
		if (!chat) return;
		const preset = PRESETS.find((p) => p.key === presetKey) || PRESETS[2];
		modal(
			'Add an agent to the thread',
			`Each agent keeps its own session and sees the thread when it's their turn. Address them with their @handle; they can @mention each other to hand off work.`,
			`${select('Role', 'preset', presetOptions(preset.key))}${field('Name', 'name', 'e.g. Designer', preset.name)}${select('Agent', 'provider', providerOptions(member(chat, chat.leadId)?.provider))}${select('Purpose', 'mode', modeOptions(preset.mode))}<label class="check"><input type="checkbox" name="fullAccess"> Full access — skip all permission prompts</label><small>Runs shell commands, network and MCP tools without asking (Claude: bypassPermissions · Codex: danger-full-access). Use only in workspaces you trust.</small><label>Model <small>optional — defaults to your CLI setting</small><input name="model" list="model-suggestions" placeholder="e.g. sonnet, claude-opus-5-5, gpt-5-codex"><datalist id="model-suggestions"></datalist></label><label>Instructions<textarea name="role" rows="4" placeholder="What this agent is good at and how it should behave">${esc(preset.role)}</textarea></label>`,
			'Add agent',
			(body) => api('members', { ...body, chatId })
		);
		const fillModels = (catalog) => {
			const list = $('#model-suggestions');
			if (!list) return;
			const provider = $('#modal-form').elements.provider.value;
			list.innerHTML = (catalog[provider] || [])
				.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`)
				.join('');
		};
		let catalog = {};
		api('models')
			.then((c) => fillModels((catalog = c)))
			.catch(() => {});
		$('#modal-form').elements.provider.onchange = () => fillModels(catalog);
		$('#modal-form').elements.fullAccess.onchange = (event) => {
			if (event.target.checked) $('#modal-form').elements.mode.value = 'implement';
		};
		$('#modal-form [name=preset]').onchange = (event) => {
			const p = PRESETS.find((x) => x.key === event.target.value);
			const form = $('#modal-form');
			form.elements.name.value = p.name;
			form.elements.mode.value = p.mode;
			form.elements.role.value = p.role;
			form.elements.name.focus();
		};
	}
	async function editMember(memberId) {
		const chat = state.chats.find((c) => c.id === chatId);
		const m = member(chat, memberId);
		if (!m) return;
		let catalog = {};
		try {
			catalog = await api('models');
		} catch {}
		const requireModel = (value) => {
			if (!value?.trim()) throw new Error('Enter a custom model ID');
			return value.trim();
		};
		const models = catalog[m.provider] || [];
		const customModel = !!m.model && !models.some((option) => option.value === m.model);
		const modelOptions = [
			{ value: '', label: 'CLI default' },
			...models,
			{ value: '__custom__', label: 'Custom model…' }
		]
			.map(
				(option) =>
					`<option value="${esc(option.value)}" ${option.value === (customModel ? '__custom__' : m.model || '') ? 'selected' : ''}>${esc(option.label)}</option>`
			)
			.join('');
		modal(
			`${esc(m.name)} <span class="muted">@${esc(m.handle)}</span>`,
			`${esc(m.provider === 'codex' ? 'Codex' : 'Claude Code')} · ${m.sessionId ? `session ${esc(m.sessionId.slice(0, 8))}` : 'not started yet'}${m.costUsd ? ` · ${money(m.costUsd)} so far` : ''}${m.activeModel ? ` · ${esc(m.activeModel)}` : ''}`,
			`${select('Purpose', 'mode', modeOptions(m.mode))}<label class="check"><input type="checkbox" id="member-write" ${m.mode === 'implement' ? 'checked' : ''} ${m.status !== 'idle' ? 'disabled' : ''}> Allow workspace writes</label><small>${m.status !== 'idle' ? 'Stop this agent to change permissions.' : 'Write access selects Implement; read-only selects Assess. Changes start a fresh session with thread context.'}</small><label class="check"><input type="checkbox" id="member-full" name="fullAccess" ${m.fullAccess ? 'checked' : ''} ${m.status !== 'idle' ? 'disabled' : ''}> Full access — skip all permission prompts</label><small>Runs shell commands, network and MCP tools without asking (Claude: bypassPermissions · Codex: danger-full-access). Use only in workspaces you trust.</small>${select('Model', 'model', modelOptions)}<label id="custom-model-label" ${customModel ? '' : 'hidden'}>Custom model<input name="customModel" value="${esc(customModel ? m.model : '')}" placeholder="Model ID"></label><small>${m.status !== 'idle' ? 'Stop this agent to change models.' : 'Model changes apply on the next turn with a fresh session and thread context.'}</small><label>Instructions<textarea name="role" rows="5">${esc(m.role)}</textarea></label><label class="check"><input type="checkbox" name="lead" ${m.id === chat.leadId ? 'checked disabled' : ''}> Thread lead — receives messages that don't @mention anyone</label>${chat.members.length > 1 ? `<button type="button" class="danger-link" id="remove-member">Remove ${esc(m.name)} from thread</button>` : ''}`,
			'Save',
			(body) =>
				api('member', {
					chatId,
					memberId,
					mode: body.mode ?? m.mode,
					fullAccess: m.status !== 'idle' ? !!m.fullAccess : body.fullAccess === 'on',
					model:
						m.status !== 'idle'
							? m.model
							: body.model === '__custom__'
								? requireModel(body.customModel)
								: body.model,
					role: body.role,
					lead: body.lead === 'on'
				})
		);
		const modelSelect = $('#modal-form').elements.model;
		modelSelect.disabled = m.status !== 'idle';
		$('#modal-form').elements.customModel.disabled = m.status !== 'idle';
		modelSelect.onchange = () => {
			$('#custom-model-label').hidden = modelSelect.value !== '__custom__';
		};
		const purpose = $('#modal-form').elements.mode;
		const write = $('#member-write');
		purpose.disabled = m.status !== 'idle';
		purpose.onchange = () => {
			write.checked = purpose.value === 'implement';
		};
		const full = $('#member-full');
		write.onchange = () => {
			purpose.value = write.checked ? 'implement' : m.mode === 'review' ? 'review' : 'assess';
			if (!write.checked) full.checked = false;
		};
		full.onchange = () => {
			if (!full.checked) return;
			write.checked = true;
			purpose.value = 'implement';
		};
		if ($('#remove-member'))
			$('#remove-member').onclick = async () => {
				try {
					await api('member-remove', { chatId, memberId });
					$('#dialog').close();
					await refresh();
				} catch (e) {
					$('#modal-error').textContent = e.message;
				}
			};
	}
	const teamRow = (presetKey, provider) => {
		const p = PRESETS.find((x) => x.key === presetKey) || PRESETS[0];
		return `<div class="team-row"><select name="team-preset" aria-label="Role">${presetOptions(p.key)}</select><input name="team-name" aria-label="Name" value="${esc(p.name)}" placeholder="Name" required maxlength="40"><select name="team-provider" aria-label="Agent">${providerOptions(provider)}</select><button type="button" class="square" data-remove-row aria-label="Remove agent">×</button></div>`;
	};
	function newChat() {
		modal(
			'Start a team thread',
			'Mix Claude and Codex, and repeat roles as often as you like. The first agent leads: messages go to it unless you @mention someone. Agents hand off to each other with @mentions.',
			`${field('Conversation title', 'title', 'e.g. Plan the onboarding launch')}<fieldset class="team-picker"><legend>Team</legend><div id="team-rows">${teamRow('lead', 'claude')}${teamRow('engineer', 'codex')}</div><div class="team-add"><button type="button" data-add-row="claude">${icon('plus')}Claude</button><button type="button" data-add-row="codex">${icon('plus')}Codex</button></div></fieldset>`,
			'Create conversation',
			async (body, form) => {
				const presets = form.getAll('team-preset'),
					names = form.getAll('team-name'),
					providers = form.getAll('team-provider');
				const members = presets.map((key, i) => {
					const p = PRESETS.find((x) => x.key === key);
					return { name: names[i], role: p.role, mode: p.mode, provider: providers[i] };
				});
				if (!members.length) throw new Error('Add at least one agent');
				const c = await api('chats', { workspaceId, title: body.title, members });
				chatId = c.id;
				tab = 'agents';
			}
		);
		const rows = $('#team-rows');
		rows.onchange = (event) => {
			if (event.target.name === 'team-preset') {
				const p = PRESETS.find((x) => x.key === event.target.value);
				const name = event.target.parentElement.querySelector('[name=team-name]');
				name.value = p.name;
				name.focus();
			}
		};
		$('#modal-form').addEventListener('click', (event) => {
			const add = event.target.closest('[data-add-row]');
			if (add) {
				const used = new Set(form().getAll('team-preset'));
				rows.insertAdjacentHTML(
					'beforeend',
					teamRow(
						PRESETS.find((p) => p.key !== 'custom' && !used.has(p.key))?.key || 'engineer',
						add.dataset.addRow
					)
				);
				rows.lastElementChild.querySelector('[name=team-name]').select();
			}
			const remove = event.target.closest('[data-remove-row]');
			if (remove && rows.children.length > 1) remove.parentElement.remove();
		});
		const form = () => new FormData($('#modal-form'));
	}
	function confirmDanger(title, description, submit, handler) {
		modal(title, description, '', submit, handler);
		const button = $('#modal-form button.primary');
		button.classList.replace('primary', 'danger');
		button.focus();
	}
	function deleteChat(id) {
		const c = state.chats.find((x) => x.id === id);
		if (!c) return;
		confirmDanger(
			'Delete conversation?',
			`<b>${esc(c.title)}</b> and its ${c.messages.length} message${c.messages.length === 1 ? '' : 's'} will be removed from Workbench. This can't be undone. Workspace files are not affected.`,
			'Delete conversation',
			async () => {
				await api('chat-delete', { chatId: id });
				drafts.delete(id);
				if (chatId === id) chatId = null;
			}
		);
	}
	function deleteProject(id) {
		const p = state.projects.find((x) => x.id === id);
		if (!p) return;
		const spaces = state.workspaces.filter((w) => w.projectId === id);
		confirmDanger(
			'Remove project?',
			`<b>${esc(p.name)}</b> will be removed from Workbench with its ${spaces.length} workspace${spaces.length === 1 ? '' : 's'}, conversations and tasks. Your repository at <code>${esc(p.path)}</code> is not touched.${spaces.length > 1 ? ' Worktrees Workbench created are deleted from disk, but their branches stay in the repository. Workspaces with uncommitted changes block removal.' : ''}`,
			'Remove project',
			async () => {
				await api('project-delete', { projectId: id });
				if (spaces.some((w) => w.id === workspaceId)) {
					workspaceId = null;
					chatId = null;
					localStorage.removeItem('wrx.workspace');
				}
			}
		);
	}
	// ─── Files: workspace tree + viewer ─────────────────────────────────────────
	const files = {
		workspace: null,
		dirs: new Map(),
		pending: new Set(),
		open: new Set(),
		selected: null,
		preview: null,
		query: '',
		results: null,
		source: false
	};
	const bytes = (n) =>
		n == null
			? ''
			: n < 1024
				? `${n} B`
				: n < 1048576
					? `${(n / 1024).toFixed(1)} KB`
					: `${(n / 1048576).toFixed(1)} MB`;
	const rawUrl = (file) =>
		`/api/wrx/workspace-file/${encodeURIComponent(workspaceId)}?path=${encodeURIComponent(file)}`;
	const kindIcon = (kind) =>
		({ image: 'image', audio: 'music', video: 'film', pdf: 'file' })[kind] || 'file';
	async function loadDir(dir) {
		if (files.pending.has(dir)) return;
		files.pending.add(dir);
		const wid = workspaceId;
		try {
			const listing = await api(
				`files?workspaceId=${encodeURIComponent(wid)}&path=${encodeURIComponent(dir)}`
			);
			if (files.workspace === wid) files.dirs.set(dir, listing);
		} catch (e) {
			if (files.workspace === wid)
				files.dirs.set(dir, { path: dir, entries: [], error: e.message });
		} finally {
			files.pending.delete(dir);
			if (tab === 'files') render();
		}
	}
	async function openFile(file) {
		const wid = workspaceId;
		files.selected = file;
		files.preview = { path: file, loading: true };
		files.source = false;
		render();
		for (let i = file.indexOf('/'); i > 0; i = file.indexOf('/', i + 1)) {
			const dir = file.slice(0, i);
			if (!files.open.has(dir)) {
				files.open.add(dir);
				if (!files.dirs.has(dir)) loadDir(dir);
			}
		}
		try {
			const preview = await api(
				`file?workspaceId=${encodeURIComponent(wid)}&path=${encodeURIComponent(file)}`
			);
			if (files.workspace === wid && files.selected === file) files.preview = preview;
		} catch (e) {
			if (files.selected === file) files.preview = { path: file, error: e.message };
		}
		render();
	}
	function treeView(dir) {
		const listing = files.dirs.get(dir);
		if (!listing) {
			loadDir(dir);
			return '<p class="tree-note">Loading…</p>';
		}
		if (listing.error) return `<p class="tree-note error">${esc(listing.error)}</p>`;
		return (
			listing.entries
				.map((e) => {
					const cls = `${e.ignored ? 'ignored' : ''}`;
					if (e.type === 'dir') {
						const open = files.open.has(e.path);
						return `<button class="tree-row dir ${open ? 'open' : ''} ${cls}" data-dir="${esc(e.path)}" role="treeitem" aria-expanded="${open}" title="${esc(e.path)}">${icon('chevron', 'twisty')}${icon('folder')}<span>${esc(e.name)}</span></button>${open ? `<div class="tree-group" role="group">${treeView(e.path)}</div>` : ''}`;
					}
					return `<button class="tree-row file ${files.selected === e.path ? 'selected' : ''} ${cls}" data-file="${esc(e.path)}" role="treeitem" title="${esc(e.path)}">${icon(kindIcon(e.kind))}<span>${esc(e.name)}</span></button>`;
				})
				.join('') +
				(listing.truncated ? '<p class="tree-note">Showing the first 3000 entries</p>' : '') ||
			'<p class="tree-note">Empty folder</p>'
		);
	}
	function previewView() {
		const p = files.preview;
		if (!p)
			return `<div class="empty">${icon('folder')}<h3>Browse the workspace.</h3><p>Pick a file to read it. Images, audio, video and PDFs open right here.</p></div>`;
		const crumbs = p.path.split('/').map(esc).join(`<i>/</i>`);
		const isMarkdown = /\.(md|markdown|mdx)$/i.test(p.path) && p.kind === 'text';
		const head = `<div class="viewer-head"><div class="viewer-path" title="${esc(p.path)}">${crumbs}</div><div class="viewer-meta">${p.size != null ? `<span>${bytes(p.size)}</span>` : ''}${isMarkdown ? `<button class="text-button" data-action="md-mode">${files.source ? 'Preview' : 'Source'}</button>` : ''}${state.chats.some((c) => c.workspaceId === workspaceId) ? `<button class="text-button" data-action="mention-file" title="Reference this file in the current conversation">Mention in chat</button>` : ''}<button class="text-button" data-action="copy-file-path">Copy path</button><a class="text-button" href="${rawUrl(p.path)}" target="_blank" rel="noopener noreferrer">Open raw</a></div></div>`;
		if (p.loading) return `${head}<div class="viewer-body"><p class="tree-note">Loading…</p></div>`;
		if (p.error)
			return `${head}<div class="viewer-body"><pre class="error">${esc(p.error)}</pre></div>`;
		const src = rawUrl(p.path);
		const body =
			p.kind === 'image'
				? `<div class="media-stage checker"><img src="${src}" alt="${esc(p.name)}"></div>`
				: p.kind === 'audio'
					? `<div class="media-stage"><div class="audio-card">${icon('music')}<b>${esc(p.name)}</b><audio controls preload="metadata" src="${src}"></audio></div></div>`
					: p.kind === 'video'
						? `<div class="media-stage"><video controls playsinline preload="metadata" src="${src}"></video></div>`
						: p.kind === 'pdf'
							? `<iframe class="pdf-frame" src="${src}" title="${esc(p.name)}"></iframe>`
							: p.kind === 'binary'
								? `<div class="empty">${icon('file')}<h3>Binary file</h3><p>${bytes(p.size)} · no preview available.</p><a class="button-link" href="${src}" download>Download</a></div>`
								: isMarkdown && !files.source
									? `<div class="markdown-view">${md(p.text)}</div>`
									: `<pre class="code-view"><code>${p.text
											.split('\n')
											.map((line) => `<span>${esc(line) || ' '}</span>`)
											.join('')}</code></pre>`;
		return `${head}<div class="viewer-body">${p.truncated ? '<p class="viewer-note">Showing the first 1 MB of this file.</p>' : ''}${body}</div>`;
	}
	function filesView() {
		if (files.workspace !== workspaceId)
			Object.assign(files, {
				workspace: workspaceId,
				dirs: new Map(),
				pending: new Set(),
				open: new Set(),
				selected: null,
				preview: null,
				query: '',
				results: null
			});
		const list = files.results
			? files.results.length
				? files.results
						.map(
							(r) =>
								`<button class="tree-row file result ${files.selected === r.path ? 'selected' : ''}" data-file="${esc(r.path)}" title="${esc(r.path)}">${icon(kindIcon(r.kind))}<span>${esc(r.name)}<small>${esc(r.path.slice(0, -r.name.length).replace(/\/$/, ''))}</small></span></button>`
						)
						.join('')
				: '<p class="tree-note">No matching files</p>'
			: treeView('');
		return `<div class="files-layout"><div class="file-tree"><div class="panel-heading"><h3>${icon('folder')}Files</h3><button class="square" data-action="files-refresh" aria-label="Refresh files" title="Refresh">${icon('refresh')}</button></div><label class="file-find">${icon('search')}<input id="file-query" type="search" placeholder="Go to file…" value="${esc(files.query)}" autocomplete="off" spellcheck="false" aria-label="Go to file"></label><div class="tree" role="tree" aria-label="Workspace files">${list}</div></div><section class="file-viewer">${previewView()}</section></div>`;
	}
	let fileSearchTimer;
	function searchWorkspaceFiles(q) {
		files.query = q;
		clearTimeout(fileSearchTimer);
		if (!q.trim()) {
			files.results = null;
			return render();
		}
		const wid = workspaceId;
		fileSearchTimer = setTimeout(async () => {
			try {
				const results = await api(
					`file-search?workspaceId=${encodeURIComponent(wid)}&q=${encodeURIComponent(q)}`
				);
				if (files.workspace === wid && files.query === q) {
					files.results = results;
					render();
				}
			} catch (e) {
				toast(e.message, 'error');
			}
		}, 120);
	}
	function changes() {
		return `<div class="section-title"><div><h2>Working changes</h2><p>Tracked changes against HEAD, with untracked paths in the status list.</p></div>${btn('Refresh changes', 'diff', 'code')}</div>${
			diff
				? `<div class="two-columns diff-columns"><section class="panel"><div class="panel-heading"><h3>Git status</h3></div><pre class="code-block">${esc(diff.status || 'Working tree is clean.')}</pre><div class="panel-heading"><h3>Recent commits</h3></div><pre class="code-block">${esc(diff.log || 'No commits yet.')}</pre></section><section class="panel"><div class="panel-heading"><h3>Diff / HEAD</h3></div><pre class="diff code-block">${
						diff.diff
							? diff.diff
									.split('\n')
									.map(
										(line) =>
											`<span class="${line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : ''}">${esc(line)}</span>`
									)
									.join('\n')
							: 'No tracked changes.'
					}</pre></section></div>`
				: '<div class="empty">Loading working tree…</div>'
		}`;
	}
	function tasksView() {
		const tasks = state.tasks.filter((t) => t.workspaceId === workspaceId);
		return `<div class="section-title"><div><h2>A clear path forward.</h2><p>Track the work without leaving the workspace.</p></div>${btn('Add task', 'task', 'plus', 'primary')}</div><div class="task-board">${[
			['todo', 'To do'],
			['doing', 'In progress'],
			['done', 'Done']
		]
			.map(
				([status, title]) =>
					`<section class="task-column"><h3><i class="task-dot ${status}"></i>${title}<span>${tasks.filter((t) => t.status === status).length}</span></h3>${
						tasks
							.filter((t) => t.status === status)
							.map(
								(t) =>
									`<article class="task-card"><p>${esc(t.title)}</p><select data-task="${t.id}" aria-label="Task status">${[
										['todo', 'To do'],
										['doing', 'In progress'],
										['done', 'Done']
									]
										.map(
											([value, label]) =>
												`<option value="${value}" ${t.status === value ? 'selected' : ''}>${label}</option>`
										)
										.join('')}</select></article>`
							)
							.join('') || '<div class="task-empty">Room for your next step.</div>'
					}</section>`
			)
			.join('')}</div>`;
	}
	function runtimeView() {
		const e = env();
		return `<div class="section-title"><div><h2>Dependencies with a home.</h2><p>VMs isolate services and databases. Agents run on the host checkout.</p></div>${btn(e ? 'Change environment' : 'Attach environment', 'environment', 'box')}</div>${e ? `<section class="panel runtime-panel"><div class="panel-heading"><h3>${icon('box')}${esc(e.name)}</h3>${badge(e.busy ? 'Working…' : e.status, e.status === 'running' ? 'green' : '')}</div><div class="runtime-details"><div><span>Isolation</span><b>${esc(e.scope)} Colima VM</b></div><div><span>Resources</span><b>${e.cpus} CPU / ${e.memory} GB RAM / ${e.disk} GB disk</b></div><div><span>Profile</span><code>${esc(e.profile)}</code></div><div><span>Docker endpoint</span><code>~/.colima/${esc(e.profile)}/docker.sock</code></div></div><div class="runtime-actions">${['start', 'stop', 'up', 'down', 'ps'].map((action) => `<button data-runtime="${action}" ${e.busy ? 'disabled' : ''}>${icon(action === 'start' ? 'arrow' : 'terminal')}${{ start: 'Start VM', stop: 'Stop VM', up: 'Compose up', down: 'Compose down', ps: 'Service status' }[action]}</button>`).join('')}</div><p class="runtime-note">Compose uses this workspace’s root Compose file and its own project namespace. Down preserves database volumes. Starting a VM may download its base image.</p><pre class="runtime-log">${esc(e.log || 'No runtime operations yet.')}</pre></section>` : `<div class="empty panel">${icon('box')}<h3>Shared when it helps. Isolated when it matters.</h3><p>Attach a shared VM or provision a dedicated dependency VM for this workspace.</p>${btn('Choose environment', 'environment', 'plus', 'primary')}</div>`}`;
	}
	function modal(title, description, fields, submit, handler) {
		const d = $('#dialog');
		d.innerHTML = `<form id="modal-form"><div class="modal-title"><h2>${title}</h2><button type="button" class="square" data-close aria-label="Close">×</button></div><p>${description}</p>${fields}<div id="modal-error" class="error" role="alert"></div><div class="modal-footer"><button type="button" data-close>Cancel</button><button class="primary">${submit}${icon('arrow')}</button></div></form>`;
		d.showModal();
		d.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => d.close()));
		$('#modal-form').onsubmit = async (event) => {
			event.preventDefault();
			const button = event.submitter;
			button.disabled = true;
			try {
				const form = new FormData(event.target);
				await handler(Object.fromEntries(form), form);
				d.close();
				await refresh();
			} catch (e) {
				$('#modal-error').textContent = e.message;
			} finally {
				button.disabled = false;
			}
		};
	}
	const field = (label, name, placeholder = '', value = '') =>
		`<label>${label}<input name="${name}" placeholder="${placeholder}" value="${esc(value)}" required></label>`;
	const select = (label, name, options) =>
		`<label>${label}<select name="${name}">${options}</select></label>`;
	const actions = {
		'conversation-fullscreen': () => {
			const transcript = $('#transcript');
			const top = transcript?.scrollTop ?? 0;
			const atBottom = transcript && transcript.scrollHeight - top - transcript.clientHeight < 24;
			conversationFullscreen = !conversationFullscreen;
			render();
			const resized = $('#transcript');
			if (resized) resized.scrollTop = atBottom ? resized.scrollHeight : top;
			$('[data-action="conversation-fullscreen"]')?.focus({ preventScroll: true });
		},
		search: () => openSearch(),
		project: () => openProject(),
		workspace: () =>
			modal(
				'Make room for a new idea',
				'Create a Git worktree from the current repository HEAD. The repository needs at least one commit.',
				`${field('Workspace name', 'name', 'e.g. Authentication refresh')}${field('New branch', 'branch', 'feat/auth-refresh')}${field('Base branch or commit', 'base', 'main', current().branch === 'detached HEAD' ? 'HEAD' : current().branch)}${select(
					'Dependency environment',
					'environmentId',
					`<option value="">No environment yet</option><option value="isolated">Create a dedicated VM</option>${state.environments
						.filter((e) => e.scope === 'shared')
						.map((e) => `<option value="${e.id}">Share: ${esc(e.name)}</option>`)
						.join('')}`
				)}`,
				'Create workspace',
				async (body) => {
					const w = await api('workspaces', {
						...body,
						projectId: project().id,
						isolated: body.environmentId === 'isolated',
						environmentId: body.environmentId === 'isolated' ? null : body.environmentId
					});
					workspaceId = w.id;
					chatId = null;
					tab = 'overview';
					localStorage.setItem('wrx.workspace', w.id);
				}
			),
		chat: () => newChat(),
		'add-member': () => memberDialog(),
		mention: () => insertText('@'),
		slash: () => {
			const box = $('#message');
			box.value = '/';
			box.focus();
			drafts.set(chatId, box.value);
			updateMenu();
		},
		attach: () => $('#image-input')?.click(),
		dictate: () => toggleDictation(),
		'files-refresh': () => {
			files.dirs = new Map();
			files.results = null;
			files.query = '';
			if (files.selected) openFile(files.selected);
			else render();
		},
		'md-mode': () => {
			files.source = !files.source;
			render();
		},
		'copy-file-path': async () => {
			await navigator.clipboard.writeText(files.preview.path);
			toast('Path copied');
		},
		'mention-file': () => {
			const chats = state.chats.filter((c) => c.workspaceId === workspaceId);
			if (!chats.some((c) => c.id === chatId)) chatId = chats.at(-1).id;
			const draft = drafts.get(chatId) || '';
			drafts.set(
				chatId,
				`${draft}${draft && !/\s$/.test(draft) ? ' ' : ''}\`${files.preview.path}\` `
			);
			tab = 'agents';
			render();
			$('#message')?.focus();
		},
		jump: () => {
			const t = $('#transcript');
			t.scrollTop = t.scrollHeight;
		},
		cancel: async () => {
			await api('cancel', { chatId });
			await refresh();
		},
		tasks: () => {
			tab = 'tasks';
			render();
		},
		'runtime-view': () => {
			tab = 'runtime';
			render();
		},
		task: () =>
			modal(
				'Add a task',
				'A small, concrete step toward done.',
				field('What needs doing?', 'title', 'e.g. Add session expiry tests'),
				'Add task',
				(body) => api('tasks', { ...body, workspaceId })
			),
		diff: async () => {
			diff = await api(`diff?workspaceId=${workspaceId}`);
			render();
		},
		environment: () =>
			modal(
				'Choose an environment',
				'A shared VM can serve multiple workspaces. An isolated VM belongs to this workspace alone.',
				select(
					'Environment',
					'choice',
					`<option value="new-isolated">New isolated VM · 2 CPU / 4 GB RAM</option><option value="new-shared">New shared VM · 2 CPU / 4 GB RAM</option><option value="">Detach environment</option>${state.environments
						.filter((e) => e.scope === 'shared' || e.workspaceId === workspaceId)
						.map((e) => `<option value="${e.id}">${esc(e.name)} (${e.scope})</option>`)
						.join('')}`
				),
				'Attach environment',
				async (body) => {
					let environmentId = body.choice;
					if (environmentId.startsWith('new-')) {
						const e = await api('environments', {
							name: `${project().name} / ${environmentId === 'new-shared' ? 'shared' : current().name}`,
							scope: environmentId === 'new-shared' ? 'shared' : 'isolated',
							workspaceId
						});
						environmentId = e.id;
					}
					await api('attach', { workspaceId, environmentId });
					tab = 'runtime';
				}
			),
		environments: () => {
			const d = $('#dialog');
			d.innerHTML = `<div class="modal-title"><h2>Environments</h2><button class="square" data-close aria-label="Close">×</button></div><p>Managed Colima dependency VMs across all projects.</p>${state.environments.map((e) => `<div class="connection-row"><div><b>${esc(e.name)}</b><small>${esc(e.profile)} · ${e.scope}</small></div>${badge(e.busy ? 'Working' : e.status)}</div>`).join('') || '<p>No environments yet. Attach one from a workspace.</p>'}`;
			d.showModal();
			d.querySelector('[data-close]').onclick = () => d.close();
		},
		computers: () => showComputers(),
		settings: () => {
			const d = $('#dialog');
			d.innerHTML = `<div class="modal-title"><h2>Local connections</h2><button class="square" data-close aria-label="Close">×</button></div><p>Workbench uses installed command line tools and their existing authentication. No API keys are stored by Workbench.</p>${Object.entries(
				state.tools
			)
				.map(
					([name, t]) =>
						`<div class="connection-row"><div><b>${esc(name)}</b><small>${esc(t.version || 'Install this tool and restart Workbench')}</small></div>${badge(t.available ? 'Installed' : 'Missing', t.available ? 'green' : '')}</div>`
				)
				.join(
					''
				)}<p>Sign in using <code>claude auth login</code> or <code>codex login</code> in your terminal. Installed status does not confirm authentication.</p>`;
			d.showModal();
			d.querySelector('[data-close]').onclick = () => d.close();
		},
		'copy-path': async () => {
			await navigator.clipboard.writeText(current().path);
			toast('Workspace path copied');
		}
	};
	on(root, 'click', async (event) => {
		const target = event.target.closest('button');
		if (!target) return;
		try {
			if (target.dataset.action) await actions[target.dataset.action]?.();
			if (target.dataset.workspace) chooseWorkspace(target.dataset.workspace);
			if (target.dataset.dir !== undefined) {
				const dir = target.dataset.dir;
				files.open.has(dir) ? files.open.delete(dir) : files.open.add(dir);
				render();
			}
			if (target.dataset.file) openFile(target.dataset.file);
			if (target.dataset.removeAttachment) {
				attachments.get(chatId)?.splice(Number(target.dataset.removeAttachment), 1);
				showAttachments();
			}
			if (target.dataset.chat) {
				if (target.dataset.chat !== chatId) stopDictation();
				chatId = target.dataset.chat;
				menu = null;
				tab = 'agents';
				render();
			}
			if (target.dataset.member) await editMember(target.dataset.member);
			if (target.dataset.deleteChat) deleteChat(target.dataset.deleteChat);
			if (target.dataset.deleteProject) deleteProject(target.dataset.deleteProject);
			if (target.dataset.menu) applyMenu(Number(target.dataset.menu));
			if (target.dataset.reply) insertText(`@${target.dataset.reply} `);
			if (target.dataset.copyMessage) {
				const m = state.chats
					.find((c) => c.id === chatId)
					?.messages.find((x) => x.id === target.dataset.copyMessage);
				await navigator.clipboard.writeText(m?.text || '');
				toast('Message copied');
			}
			if (target.dataset.tab) {
				tab = target.dataset.tab;
				render();
				if (tab === 'changes') await actions.diff();
			}
			if (target.dataset.runtime) {
				await api('runtime', {
					environmentId: env().id,
					workspaceId,
					action: target.dataset.runtime
				});
				await refresh();
			}
		} catch (e) {
			toast(e.message, 'error');
		}
	});
	on(
		root,
		'toggle',
		(event) => {
			const key = event.target.dataset?.open;
			if (key) event.target.open ? openKeys.add(key) : openKeys.delete(key);
		},
		true
	);
	on(
		root,
		'scroll',
		(event) => {
			if (event.target.id === 'transcript') {
				const t = event.target;
				$('.jump')?.classList.toggle('hidden', t.scrollHeight - t.scrollTop - t.clientHeight < 80);
			}
		},
		true
	);
	on(root, 'click', (event) => {
		if (event.target.id === 'message') updateMenu();
	});
	on(root, 'input', (event) => {
		if (event.target.id === 'file-query') searchWorkspaceFiles(event.target.value);
	});
	on(root, 'keydown', (event) => {
		if (event.target.id === 'file-query' && event.key === 'Enter' && files.results?.length) {
			event.preventDefault();
			openFile(files.results[0].path);
		}
		if (event.target.id === 'file-query' && event.key === 'Escape' && files.query) {
			event.preventDefault();
			event.target.value = '';
			searchWorkspaceFiles('');
		}
	});
	on(root, 'input', (event) => {
		if (event.target.id === 'message') {
			drafts.set(chatId, event.target.value);
			updateMenu();
		}
	});
	on(root, 'change', async (event) => {
		if (event.target.dataset.task) {
			try {
				await api('task-status', { id: event.target.dataset.task, status: event.target.value });
				await refresh();
			} catch (e) {
				toast(e.message, 'error');
			}
		}
	});
	on(root, 'submit', async (event) => {
		if (event.target.id !== 'message-form') return;
		event.preventDefault();
		if (voice.session) await voice.session.stop(); // flush the phrase in flight into the box first
		const message = $('#message');
		const text = message.value;
		const pending = attachments.get(chatId) || [];
		if (!text.trim() && !pending.length) return;
		try {
			if (text.startsWith('/') && !text.startsWith('//')) {
				if (!(await slashCommand(text)))
					throw new Error(
						`Unknown command ${text.split(/\s/)[0]}. Try /add, /new, /stop or /lead.`
					);
			} else {
				await api('turn', {
					chatId,
					text: text.replace(/^\/\//, '/'),
					images: pending.map(({ name, type, data }) => ({ name, type, data }))
				});
				attachments.delete(chatId);
			}
			$('#message').value = '';
			menu = null;
			drafts.delete(chatId);
			await refresh();
		} catch (e) {
			toast(e.message, 'error');
		}
	});
	on(root, 'change', (event) => {
		if (event.target.id === 'image-input') {
			addImages([...event.target.files]).catch((e) => toast(e.message, 'error'));
			event.target.value = '';
		}
	});
	on(root, 'paste', (event) => {
		if (event.target.id !== 'message') return;
		const files = [...(event.clipboardData?.files || [])].filter((f) =>
			f.type.startsWith('image/')
		);
		if (!files.length) return;
		event.preventDefault();
		addImages(files).catch((e) => toast(e.message, 'error'));
	});
	// Files dropped anywhere outside a conversation must not navigate the page away.
	const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');
	on(root, 'dragover', (event) => {
		if (!hasFiles(event)) return;
		event.preventDefault();
		const main = chatId && event.target.closest?.('.conversation-main');
		event.dataTransfer.dropEffect = main ? 'copy' : 'none';
		main?.classList.add('dropping');
	});
	on(root, 'dragleave', (event) => {
		const main = event.target.closest?.('.conversation-main');
		if (main && !main.contains(event.relatedTarget)) main.classList.remove('dropping');
	});
	on(root, 'drop', (event) => {
		if (!hasFiles(event)) return;
		event.preventDefault();
		const main = event.target.closest?.('.conversation-main');
		if (!main || !chatId) return;
		main.classList.remove('dropping');
		addImages([...event.dataTransfer.files]).catch((e) => toast(e.message, 'error'));
	});
	on(document, 'keydown', (event) => {
		if (event.altKey && !event.metaKey && !event.ctrlKey && event.code === 'KeyM' && $('#mic')) {
			event.preventDefault();
			toggleDictation();
			return;
		}
		if (event.target.id !== 'message' || event.isComposing) return;
		const box = event.target;
		const chat = state.chats.find((c) => c.id === chatId);
		if (menu?.items.length) {
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				menu.index =
					(menu.index + (event.key === 'ArrowDown' ? 1 : -1) + menu.items.length) %
					menu.items.length;
				$('#composer-menu').innerHTML = menuView();
				return;
			}
			if (
				event.key === 'Tab' ||
				(event.key === 'Enter' &&
					!event.shiftKey &&
					(menu.type === 'mention' || box.value.trim() !== menu.items[menu.index].value))
			) {
				event.preventDefault();
				applyMenu();
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				menu = null;
				$('#composer-menu').innerHTML = '';
				return;
			}
		}
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			$('#message-form').requestSubmit();
			return;
		}
		if (event.key === 'Escape' && voice.session) {
			event.preventDefault();
			stopDictation();
			return;
		}
		if (event.key === 'Escape' && chat?.members.some((m) => m.status !== 'idle')) {
			event.preventDefault();
			actions.cancel().catch((e) => toast(e.message, 'error'));
			return;
		}
		if (event.key === 'ArrowUp' && !box.value) {
			const last = chat?.messages.findLast((m) => m.role === 'user');
			if (last) {
				event.preventDefault();
				box.value = last.text;
				drafts.set(chatId, box.value);
				updateMenu();
			}
		}
	});
	async function registerProject(directory) {
		const p = await api('projects', { path: directory });
		await refresh();
		chooseWorkspace(state.workspaces.find((w) => w.projectId === p.id).id);
	}
	async function openProject() {
		if (state.remote) return folderDialog();
		const native = window.webkit?.messageHandlers?.chooseProject;
		const result = native ? await native.postMessage({}) : await api('pick-directory', {});
		if (result.unavailable) return folderDialog();
		if (result.path) await registerProject(result.path);
	}
	async function folderDialog(start) {
		const d = $('#dialog');
		let generation = 0;
		async function browse(directory) {
			const request = ++generation;
			const listing = await api(
				`directories${directory ? `?path=${encodeURIComponent(directory)}` : ''}`
			);
			if (request !== generation) return;
			d.innerHTML = `<div class="modal-title"><h2>Open a project</h2><button class="square" data-close aria-label="Close">×</button></div><p>Choose a repository on <b>${esc(state.machine?.name || 'this computer')}</b>.</p><div class="folder-toolbar"><button id="folder-home">Home</button><button id="folder-up" ${listing.parent ? '' : 'disabled'}>↑ Parent folder</button></div><div class="folder-location" aria-label="Current folder">${esc(listing.path)}</div><div class="folder-list" role="list" aria-label="Folders">${listing.directories.map((entry) => `<button class="folder-entry" data-folder="${esc(entry.path)}" role="listitem">${icon('box')}<span>${esc(entry.name)}</span>${icon('chevron')}</button>`).join('') || '<p class="folder-empty">No subfolders</p>'}</div><div id="folder-error" class="error" role="alert"></div><div class="modal-footer folder-footer"><span>${listing.repository ? 'Git repository' : 'Choose a folder containing a Git repository'}</span><button data-close>Cancel</button><button id="folder-open" class="primary" ${listing.repository ? '' : 'disabled'}>Open Project ${icon('arrow')}</button></div>`;
			if (!d.open) d.showModal();
			const navigate = (dir) =>
				browse(dir).catch((e) => {
					$('#folder-error').textContent = e.message;
				});
			d.querySelectorAll('[data-close]').forEach((button) => (button.onclick = () => d.close()));
			d.querySelectorAll('[data-folder]').forEach(
				(button) => (button.onclick = () => navigate(button.dataset.folder))
			);
			$('#folder-home').onclick = () => navigate(listing.home);
			$('#folder-up').onclick = () => navigate(listing.parent);
			$('#folder-open').onclick = async (event) => {
				const button = event.currentTarget;
				button.disabled = true;
				try {
					await registerProject(listing.path);
					d.close();
				} catch (e) {
					$('#folder-error').textContent = e.message;
					button.disabled = false;
				}
			};
		}
		await browse(start);
	}
	async function showComputers() {
		const info = await api('network');
		const d = $('#dialog');
		let saved = [];
		try {
			saved = JSON.parse(localStorage.getItem('wrx.computers') || '[]');
		} catch {}
		d.innerHTML = `<div class="modal-title"><h2>Your computers</h2><button class="square" data-close aria-label="Close">×</button></div><p>Working on <b>${esc(info.machine.name)}</b>. Every action runs on the computer serving Corpus.</p><div class="network-status">${badge(info.urls.length ? 'Reachable on the network' : 'Local access only', info.urls.length ? 'green' : '')}${info.urls.length ? `<p>Open one of these addresses on your other laptop and sign in to Corpus:</p>${info.urls.map((url) => `<div class="host-url"><code>${esc(url)}</code><button data-copy="${esc(url)}">Copy</button></div>`).join('')}<small>Only reachable if Corpus listens on the network (for example <code>vite dev --host</code>).</small>` : ''}</div><h3>Connect to another computer</h3><form id="computer-form"><label>Corpus address<input name="url" placeholder="https://192.168.1.20:5173" required type="url"></label><button class="primary">Connect ${icon('arrow')}</button><div class="error" id="computer-error" role="alert"></div></form>${saved.length ? `<div class="saved-computers">${saved.map((url) => `<button data-connect="${esc(url)}">${icon('terminal')}${esc(url)}</button>`).join('')}</div>` : ''}`;
		if (!d.open) d.showModal();
		d.querySelector('[data-close]').onclick = () => d.close();
		async function copy(text) {
			try {
				await navigator.clipboard.writeText(text);
				toast('Copied');
			} catch {
				toast('Select and copy the value above');
			}
		}
		d.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => copy(b.dataset.copy)));
		function connect(value) {
			const url = new URL(value);
			if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash)
				throw new Error('Use a Corpus address, without credentials');
			localStorage.setItem(
				'wrx.computers',
				JSON.stringify([...new Set([url.origin, ...saved])].slice(0, 10))
			);
			location.assign(`${url.origin}/workbench`);
		}
		$('#computer-form').onsubmit = (event) => {
			event.preventDefault();
			try {
				connect(new FormData(event.target).get('url'));
			} catch (e) {
				$('#computer-error').textContent = e.message;
			}
		};
		d.querySelectorAll('[data-connect]').forEach(
			(b) =>
				(b.onclick = () => {
					try {
						connect(b.dataset.connect);
					} catch (e) {
						toast(e.message, 'error');
					}
				})
		);
	}
	// Live updates: the host pushes `change` events; refreshes are coalesced. EventSource reconnects on
	// its own, and every (re)open refreshes so changes made while disconnected show up.
	function watch() {
		events = new EventSource('/api/wrx/events');
		// A change that lands while a refresh is in flight re-runs it once afterwards, so the
		// last update of a run is never dropped.
		let again = false;
		const soon = () => {
			if (loading) {
				again = true;
				return;
			}
			loading = true;
			setTimeout(async () => {
				try {
					await refresh();
				} catch {}
				loading = false;
				if (again) {
					again = false;
					soon();
				}
			}, 300);
		};
		events.addEventListener('change', soon);
		events.addEventListener('open', soon);
	}
	// Deep links from Corpus (dashboard tasks, ⌘K search):
	// /workbench?workspace=<id>&tab=<tab>&chat=<id> or ?dialog=environments
	function applyLink(params) {
		const ws = params.get('workspace');
		if (ws && ws !== workspaceId) {
			stopDictation();
			workspaceId = ws;
			chatId = null;
			diff = null;
			tab = 'overview';
			localStorage.setItem('wrx.workspace', ws);
		}
		if (['overview', 'agents', 'files', 'tasks', 'runtime'].includes(params.get('tab')))
			tab = params.get('tab');
		if (params.get('chat')) {
			if (params.get('chat') !== chatId) stopDictation();
			chatId = params.get('chat');
			tab = 'agents';
			menu = null;
		}
		if (!state) return;
		render();
		if (params.get('dialog') === 'environments') actions.environments();
	}
	async function boot() {
		const params = new URLSearchParams(location.search);
		applyLink(params);
		await refresh();
		if (params.get('dialog') === 'environments') actions.environments();
		watch();
	}
	boot().catch((e) => {
		$('#app').textContent = `Unable to load the workbench: ${e.message}`;
	});
	const destroy = () => {
		destroyed = true;
		events?.close();
		stopDictation();
		for (const off of listeners) off();
	};
	// The page calls this when Corpus navigates to /workbench?… while the workbench is already open.
	destroy.navigate = applyLink;
	return destroy;
}
