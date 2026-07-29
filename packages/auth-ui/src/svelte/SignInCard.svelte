<script lang="ts">
    import { readLastLoginMethod } from "../core/last-login-method";
    import { createSignInController } from "../core/sign-in";
    import { signInWithSocial } from "../core/social";
    import AnonymousButton from "./AnonymousButton.svelte";
    import AuthCard from "./AuthCard.svelte";
    import AuthDivider from "./AuthDivider.svelte";
    import AuthLink from "./AuthLink.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import Field from "./Field.svelte";
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
    // Read once at initialisation rather than in an effect: it is a cookie, it is
    // available before the first paint, and it only picks a badge.
    const lastUsed = readLastLoginMethod();
</script>

<AuthCard title={t.signIn}>
    <SocialButtons
        lastUsed={context.plugins.lastLoginMethod ? lastUsed : undefined}
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
            <Field
                autoComplete="email"
                field={$form.fields.email}
                label={t.emailLabel}
                name="email"
                onBlur={() => {
                    actions.blur("email");
                }}
                onChange={(value) => {
                    actions.setField("email", value);
                }}
                type="email"
            />
            <Field
                autoComplete="current-password"
                field={$form.fields.password}
                label={t.passwordLabel}
                name="password"
                onBlur={() => {
                    actions.blur("password");
                }}
                onChange={(value) => {
                    actions.setField("password", value);
                }}
                type="password"
            />
            <AuthLink href={forgotPasswordHref}>{t.forgotPasswordLink}</AuthLink>
            <SubmitButton pending={$form.status === "submitting"}>{t.signIn}</SubmitButton>
        </form>
    {/if}
    {#snippet footer()}
        <AuthLink href={signUpHref}>{t.noAccount}</AuthLink>
    {/snippet}
</AuthCard>
