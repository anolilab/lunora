<script lang="ts">
    import { onMount } from "svelte";
    import { LAST_METHOD_EMAIL, readLastLoginMethod } from "../core/last-login-method";
    import { createSignInController } from "../core/sign-in";
    import { signInWithSocial } from "../core/social";
    import AnonymousButton from "./AnonymousButton.svelte";
    import AuthCard from "./AuthCard.svelte";
    import AuthDivider from "./AuthDivider.svelte";
    import AuthLink from "./AuthLink.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import FormField from "./FormField.svelte";
    import FormBanner from "./FormBanner.svelte";
    import SocialButtons from "./SocialButtons.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    let {
        forgotPasswordHref = "/forgot-password",
        signUpHref = "/sign-up",
    }: {
        forgotPasswordHref?: string;
        signUpHref?: string;
    } = $props();

    const context = useAuthUI();
    const t = context.localization;
    const social = context.social;
    const { actions, state: form } = controllerStore(createSignInController);
    // Read after mount, not at initialisation: the server has no cookie, so a
    // render-time read is a hydration mismatch. See `lastLoginMethodStore`.
    let lastUsedAfterMount = $state<string | undefined>(undefined);

    onMount(() => {
        lastUsedAfterMount = readLastLoginMethod();
    });

    const lastUsed = $derived(context.plugins.lastLoginMethod ? lastUsedAfterMount : undefined);
</script>

<AuthCard title={t.signIn}>
    <SocialButtons
        {lastUsed}
        onSelect={(provider) => {
            void signInWithSocial(context, provider);
        }}
        providers={social}
    />
    {#if context.plugins.anonymous}
        <AnonymousButton />
    {/if}
    {#if social.length > 0 && context.credentials}
        <AuthDivider />
    {/if}
    <!--
        An OAuth-only deployment has no password form to show. Discovery reports
        that as `emailAndPassword: false`; without discovery it defaults to true,
        which is the pre-existing behaviour.
    -->
    {#if context.credentials}
        <form
            class="lunora-auth-form"
            novalidate
            onsubmit={(event) => {
                event.preventDefault();
                void actions.submit();
            }}
        >
            <FormBanner error={$form.formError} />
            <FormField {actions} autoComplete="email" field="email" fields={$form.fields} label={t.emailLabel} type="email" />
            <FormField {actions} autoComplete="current-password" field="password" fields={$form.fields} label={t.passwordLabel} type="password" />
            <AuthLink href={forgotPasswordHref}>{t.forgotPasswordLink}</AuthLink>
            <SubmitButton pending={$form.status === "submitting"}>
                {t.signIn}
                <!-- better-auth records a password sign-in as "email", so without this the badge is invisible for the most common route there is. -->
                {#if lastUsed === LAST_METHOD_EMAIL}
                    <span class="lunora-auth-social__badge">{t.lastUsed}</span>
                {/if}
            </SubmitButton>
        </form>
    {/if}
    {#snippet footer()}
        {#if context.signUp}
            <AuthLink href={signUpHref}>{t.noAccount}</AuthLink>
        {/if}
    {/snippet}
</AuthCard>
