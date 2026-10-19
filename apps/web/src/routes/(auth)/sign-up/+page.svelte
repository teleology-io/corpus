<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import BrandIcon from '#lib/components/ui/BrandIcon.svelte';
	import { authClient } from '@corpus/auth/client';

	let name = $state('');
	let email = $state('');
	let password = $state('');
	let error = $state('');
	let busy = $state(false);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = '';
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
		const res = await authClient.signUp.email({ name, email, password, timezone });
		busy = false;
		if (res.error) error = res.error.message ?? 'Sign up failed';
		else await goto('/dashboard');
	}
</script>

<svelte:head><title>Create account · Corpus</title></svelte:head>

<h1 class="text-2xl font-bold tracking-tight">Create your account</h1>
<p class="mt-1 text-muted">A personal workspace is set up for you automatically.</p>

<form class="mt-8 space-y-4" onsubmit={submit}>
	<div>
		<label class="label" for="name">Full name</label>
		<input id="name" class="input" autocomplete="name" required bind:value={name} />
	</div>
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
			autocomplete="new-password"
			minlength="8"
			required
			bind:value={password}
		/>
		<p class="mt-1 text-xs text-muted">At least 8 characters.</p>
	</div>
	{#if error}<p class="text-sm text-red-600">{error}</p>{/if}
	<button class="btn-primary h-10 w-full" disabled={busy}
		>{busy ? 'Creating…' : 'Create account'}</button
	>
</form>

{#if page.data.githubEnabled}
	<div class="my-6 flex items-center gap-3 text-xs text-muted">
		<span class="h-px flex-1 bg-line"></span>or<span class="h-px flex-1 bg-line"></span>
	</div>
	<button
		class="btn-outline h-10 w-full"
		onclick={() => authClient.signIn.social({ provider: 'github', callbackURL: '/dashboard' })}
	>
		<BrandIcon name="github" /> Continue with GitHub
	</button>
{/if}

<p class="mt-8 text-center text-sm text-muted">
	Already have an account? <a class="font-semibold text-primary-600 hover:underline" href="/sign-in"
		>Sign in</a
	>
</p>
