<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import BrandIcon from '#lib/components/ui/BrandIcon.svelte';
	import { authClient } from '@corpus/auth/client';

	let email = $state('');
	let password = $state('');
	let error = $state('');
	let busy = $state(false);
	const next = $derived(page.url.searchParams.get('next') || '/dashboard');

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = '';
		const res = await authClient.signIn.email({ email, password });
		busy = false;
		if (res.error) error = res.error.message ?? 'Sign in failed';
		else if (!(res.data && 'twoFactorRedirect' in res.data && res.data.twoFactorRedirect))
			await goto(next);
	}

	function github() {
		void authClient.signIn.social({ provider: 'github', callbackURL: next });
	}
</script>

<svelte:head><title>Sign in · Corpus</title></svelte:head>

<h1 class="text-2xl font-bold tracking-tight">Welcome back</h1>
<p class="mt-1 text-muted">Sign in to your Corpus account.</p>

<form class="mt-8 space-y-4" onsubmit={submit}>
	<div>
		<label class="label" for="email">Email</label>
		<input id="email" class="input" type="email" autocomplete="email" required bind:value={email} />
	</div>
	<div>
		<label class="label" for="password">Password</label>
		<input
			id="password"
			class="input"
			type="password"
			autocomplete="current-password"
			required
			bind:value={password}
		/>
	</div>
	{#if error}<p class="text-sm text-red-600">{error}</p>{/if}
	<button class="btn-primary h-10 w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button
	>
</form>

{#if page.data.githubEnabled}
	<div class="my-6 flex items-center gap-3 text-xs text-muted">
		<span class="h-px flex-1 bg-line"></span>or<span class="h-px flex-1 bg-line"></span>
	</div>
	<button class="btn-outline h-10 w-full" onclick={github}
		><BrandIcon name="github" /> Continue with GitHub</button
	>
{/if}

<p class="mt-8 text-center text-sm text-muted">
	New to Corpus? <a class="font-semibold text-primary-600 hover:underline" href="/sign-up"
		>Create an account</a
	>
</p>
