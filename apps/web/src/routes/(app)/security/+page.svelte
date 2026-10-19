<script lang="ts">
	import { onMount } from 'svelte';
	import { refreshAll } from '$app/navigation';
	import { renderSVG } from 'uqr';
	import { KeyRound, ShieldCheck, MonitorSmartphone, LogOut } from '@lucide/svelte';
	import { authClient } from '@corpus/auth/client';
	import Modal from '#lib/components/ui/Modal.svelte';
	import { toast } from '#lib/stores/toast.svelte.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	interface SessionRow {
		id: string;
		token: string;
		userAgent?: string | null;
		ipAddress?: string | null;
		createdAt: Date;
		expiresAt: Date;
	}

	let sessions = $state<SessionRow[]>([]);
	let currentToken = $state<string | null>(null);

	let currentPassword = $state('');
	let newPassword = $state('');
	let revokeOthers = $state(true);

	let tfaOpen = $state(false);
	let tfaPassword = $state('');
	let tfaUri = $state<string | null>(null);
	let tfaCodes = $state<string[]>([]);
	let tfaCode = $state('');
	let busy = $state(false);

	onMount(loadSessions);

	async function loadSessions() {
		const [list, current] = await Promise.all([authClient.listSessions(), authClient.getSession()]);
		sessions = (list.data ?? []) as SessionRow[];
		currentToken = current.data?.session.token ?? null;
	}

	async function changePassword(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		const res = await authClient.changePassword({
			currentPassword,
			newPassword,
			revokeOtherSessions: revokeOthers
		});
		busy = false;
		if (res.error)
			return toast('Could not change password', { tone: 'error', body: res.error.message });
		currentPassword = newPassword = '';
		toast('Password updated', { tone: 'success' });
		await loadSessions();
	}

	async function startTfa(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		const res = data.user.twoFactorEnabled
			? await authClient.twoFactor.disable({ password: tfaPassword })
			: await authClient.twoFactor.enable({ password: tfaPassword });
		busy = false;
		if (res.error) return toast('Two-factor', { tone: 'error', body: res.error.message });
		if (data.user.twoFactorEnabled) {
			tfaOpen = false;
			toast('Two-factor disabled', { tone: 'success' });
			return refreshAll();
		}
		const d = res.data as { totpURI: string; backupCodes: string[] };
		tfaUri = d.totpURI;
		tfaCodes = d.backupCodes;
	}

	async function verifyTfa(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		const res = await authClient.twoFactor.verifyTotp({ code: tfaCode.trim() });
		busy = false;
		if (res.error) return toast('Invalid code', { tone: 'error', body: res.error.message });
		tfaOpen = false;
		toast('Two-factor enabled', {
			tone: 'success',
			body: 'Keep your backup codes somewhere safe.'
		});
		await refreshAll();
	}

	function openTfa() {
		tfaPassword = '';
		tfaUri = null;
		tfaCodes = [];
		tfaCode = '';
		tfaOpen = true;
	}

	async function revoke(token: string) {
		await authClient.revokeSession({ token });
		await loadSessions();
	}

	async function revokeAll() {
		await authClient.revokeOtherSessions();
		toast('Signed out other devices', { tone: 'success' });
		await loadSessions();
	}

	const device = (ua?: string | null) => {
		if (!ua) return 'Unknown device';
		const browser = /Edg\//.test(ua)
			? 'Edge'
			: /Chrome\//.test(ua)
				? 'Chrome'
				: /Firefox\//.test(ua)
					? 'Firefox'
					: /Safari\//.test(ua)
						? 'Safari'
						: 'Browser';
		const os = /Mac OS X/.test(ua)
			? 'macOS'
			: /Windows/.test(ua)
				? 'Windows'
				: /iPhone|iPad/.test(ua)
					? 'iOS'
					: /Android/.test(ua)
						? 'Android'
						: /Linux/.test(ua)
							? 'Linux'
							: '';
		return `${browser}${os ? ` on ${os}` : ''}`;
	};
</script>

<svelte:head><title>Security · Corpus</title></svelte:head>

<div class="mx-auto max-w-3xl space-y-6 p-4 lg:p-8">
	<section class="card p-5">
		<h2 class="flex items-center gap-2 font-semibold">
			<KeyRound class="size-4 text-primary-500" /> Password
		</h2>
		<form class="mt-4 grid gap-3 sm:grid-cols-2" onsubmit={changePassword}>
			<div>
				<label class="label" for="cur">Current password</label>
				<input
					id="cur"
					type="password"
					class="input"
					autocomplete="current-password"
					bind:value={currentPassword}
					required
				/>
			</div>
			<div>
				<label class="label" for="new">New password</label>
				<input
					id="new"
					type="password"
					class="input"
					autocomplete="new-password"
					minlength="8"
					bind:value={newPassword}
					required
				/>
			</div>
			<label class="flex items-center gap-2 text-sm text-muted sm:col-span-2"
				><input type="checkbox" class="accent-primary-500" bind:checked={revokeOthers} /> Sign out of
				other devices</label
			>
			<div><button class="btn-primary" disabled={busy}>Update password</button></div>
		</form>
	</section>

	<section class="flex flex-wrap items-center gap-4 card p-5">
		<span
			class="flex size-10 items-center justify-center rounded-xl {data.user.twoFactorEnabled
				? 'bg-emerald-50 text-emerald-600'
				: 'bg-canvas text-muted'}"><ShieldCheck class="size-5" /></span
		>
		<div class="flex-1">
			<h2 class="font-semibold">Two-factor authentication</h2>
			<p class="text-sm text-muted">
				{data.user.twoFactorEnabled
					? 'Enabled — you’ll be asked for a code from your authenticator app.'
					: 'Add a second step to sign in with an authenticator app.'}
			</p>
		</div>
		<button class={data.user.twoFactorEnabled ? 'btn-outline' : 'btn-primary'} onclick={openTfa}
			>{data.user.twoFactorEnabled ? 'Disable' : 'Enable'}</button
		>
	</section>

	<section class="card">
		<div class="flex items-center gap-3 border-b border-line px-5 py-4">
			<h2 class="flex flex-1 items-center gap-2 font-semibold">
				<MonitorSmartphone class="size-4 text-primary-500" /> Active sessions
			</h2>
			{#if sessions.length > 1}<button class="btn-outline h-8 text-xs" onclick={revokeAll}
					><LogOut class="size-3.5" /> Sign out others</button
				>{/if}
		</div>
		<ul class="divide-y divide-line">
			{#each sessions as s (s.id)}
				<li class="flex items-center gap-3 px-5 py-3">
					<div class="flex-1">
						<p class="text-sm font-medium">
							{device(s.userAgent)}
							{#if s.token === currentToken}<span class="ml-1 chip bg-primary-50 text-primary-600"
									>This device</span
								>{/if}
						</p>
						<p class="text-xs text-muted">
							{s.ipAddress ?? 'Unknown IP'} · signed in {new Date(s.createdAt).toLocaleString()}
						</p>
					</div>
					{#if s.token !== currentToken}<button
							class="btn-ghost h-8 text-xs hover:text-red-600"
							onclick={() => revoke(s.token)}>Revoke</button
						>{/if}
				</li>
			{/each}
		</ul>
	</section>
</div>

<Modal
	bind:open={tfaOpen}
	title={data.user.twoFactorEnabled ? 'Disable two-factor' : 'Enable two-factor'}
	size="sm"
>
	{#snippet icon()}<ShieldCheck class="size-5" />{/snippet}
	{#if !tfaUri}
		<form id="tfa-pass" class="space-y-3" onsubmit={startTfa}>
			<p class="text-sm text-muted">Confirm your password to continue.</p>
			<input
				type="password"
				class="input"
				placeholder="Password"
				autocomplete="current-password"
				bind:value={tfaPassword}
				required
			/>
		</form>
	{:else}
		<form id="tfa-verify" class="space-y-4" onsubmit={verifyTfa}>
			<p class="text-sm text-muted">Scan with Google Authenticator, 1Password, Authy…</p>
			<div class="mx-auto w-44 rounded-lg border border-line p-2">
				<!-- SVG is generated locally from our own TOTP URI, not user HTML -->
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				{@html renderSVG(tfaUri, { border: 1 })}
			</div>
			<details class="text-xs text-muted">
				<summary class="cursor-pointer">Backup codes</summary>
				<div class="mt-2 grid grid-cols-2 gap-1 font-mono">
					{#each tfaCodes as c (c)}<span>{c}</span>{/each}
				</div>
			</details>
			<input
				class="input text-center tracking-[0.4em]"
				inputmode="numeric"
				placeholder="123456"
				autocomplete="one-time-code"
				bind:value={tfaCode}
				required
			/>
		</form>
	{/if}
	{#snippet footer()}
		<div class="ml-auto flex gap-2">
			<button class="btn-outline" onclick={() => (tfaOpen = false)}>Cancel</button>
			<button class="btn-primary" form={tfaUri ? 'tfa-verify' : 'tfa-pass'} disabled={busy}
				>{tfaUri ? 'Verify & enable' : 'Continue'}</button
			>
		</div>
	{/snippet}
</Modal>
