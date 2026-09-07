<script lang="ts">
    import { viewHref } from "../core/config";
    import { createForgotPasswordController } from "../core/forgot-password";
    import AuthCard from "./AuthCard.svelte";
    import AuthLink from "./AuthLink.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import FormField from "./FormField.svelte";
    import FormBanner from "./FormBanner.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    let {
        resetPath,
        signInHref,
    }: {
        /** Defaults to the configured reset-password route; see `viewPaths.base`. */
        resetPath?: string;
        /** Defaults to the configured sign-in route; see `viewPaths.base`. */
        signInHref?: string;
    } = $props();

    const context = useAuthUI();
    const t = context.localization;
    const signInLink = $derived(signInHref ?? viewHref(context, "signIn"));
    // The controller is created once per mount; `resetPath` is read at init.
    const { actions, state: form } = controllerStore((context) => createForgotPasswordController(context, { resetPath }));
</script>

<AuthCard title={t.forgotPassword}>
    <form
        class="lunora-auth-form"
        novalidate
        onsubmit={(event) => {
            event.preventDefault();
            void actions.submit();
        }}
    >
        <FormBanner error={$form.formError} success={$form.successMessage} />
        <FormField {actions} autoComplete="email" field="email" fields={$form.fields} label={t.emailLabel} type="email" />
        <SubmitButton pending={$form.status === "submitting"}>{t.forgotPassword}</SubmitButton>
    </form>
    {#snippet footer()}
        <AuthLink href={signInLink}>{t.backToSignIn}</AuthLink>
    {/snippet}
</AuthCard>
