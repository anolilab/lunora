<script lang="ts">
    import { createSignUpController } from "../core/sign-up";
    import { signInWithSocial } from "../core/social";
    import AuthCard from "./AuthCard.svelte";
    import AuthDivider from "./AuthDivider.svelte";
    import AuthLink from "./AuthLink.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import FormField from "./FormField.svelte";
    import FormBanner from "./FormBanner.svelte";
    import PasswordStrength from "./PasswordStrength.svelte";
    import SocialButtons from "./SocialButtons.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    let {
        signInHref,
    }: {
        /** Defaults to `redirects.signIn`, itself derived from `viewPaths.base`. */
        signInHref?: string;
    } = $props();

    const context = useAuthUI();
    const signInLink = $derived(signInHref ?? context.redirects.signIn);
    const t = context.localization;
    const social = context.social;
    const { actions, state: form } = controllerStore(createSignUpController);
</script>

<!--
    The server can close self-serve sign-up (`emailAndPassword.disableSignUp`).
    Mirrors the plugin-gated cards: mounted directly, this card renders
    nothing rather than a form that will fail on submit; `AuthView`'s route
    falls back to the sign-in card instead of landing on a blank page.
-->
{#if context.signUp}
    <AuthCard title={t.signUp}>
        <!--
        Social buttons belong on sign-up too — OAuth is a sign-up path, not just a
        sign-in one, and omitting them here sends new users through a password form
        they never needed. This was the gap against better-auth-ui's <AuthView>.
    -->
        <SocialButtons
            onSelect={(provider) => {
                void signInWithSocial(context, provider);
            }}
            providers={social}
        />
        {#if social.length > 0}
            <AuthDivider />
        {/if}
        <form
            class="lunora-auth-form"
            novalidate
            onsubmit={(event) => {
                event.preventDefault();
                void actions.submit();
            }}
        >
            <FormBanner error={$form.formError} />
            <FormField {actions} autoComplete="name" field="name" fields={$form.fields} label={t.nameLabel} />
            <FormField {actions} autoComplete="email" field="email" fields={$form.fields} label={t.emailLabel} type="email" />
            <FormField {actions} autoComplete="new-password" field="password" fields={$form.fields} label={t.passwordLabel} type="password" />
            <PasswordStrength value={$form.fields.password.value} />
            <SubmitButton pending={$form.status === "submitting"}>{t.signUp}</SubmitButton>
        </form>
        {#snippet footer()}
            <AuthLink href={signInLink}>{t.haveAccount}</AuthLink>
        {/snippet}
    </AuthCard>
{/if}
