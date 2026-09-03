<script lang="ts">
    import { isFlowEnabled } from "../core/flow-gate";
    import { LAST_METHOD_MAGIC_LINK, readLastLoginMethod } from "../core/last-login-method";
    import { createMagicLinkController } from "../core/magic-link";
    import AuthCard from "./AuthCard.svelte";
    import AuthLink from "./AuthLink.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import FormField from "./FormField.svelte";
    import FormBanner from "./FormBanner.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    let { signInHref = "/sign-in" }: { signInHref?: string } = $props();

    const context = useAuthUI();
    const t = context.localization;
    const enabled = isFlowEnabled(context, "magicLink", "MagicLinkCard");
    const { actions, state: form } = controllerStore(createMagicLinkController);
    // Read once at initialisation rather than in an effect: it is a cookie, it
    // is available before the first paint, and it only picks a badge.
    const lastUsed = readLastLoginMethod();
</script>

{#if enabled}
    <AuthCard title={t.magicLink}>
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
            <SubmitButton pending={$form.status === "submitting"}>
                {t.magicLink}
                {#if lastUsed === LAST_METHOD_MAGIC_LINK}
                    <span class="lunora-auth-social__badge">{t.lastUsed}</span>
                {/if}
            </SubmitButton>
        </form>
        {#snippet footer()}
            <AuthLink href={signInHref}>{t.backToSignIn}</AuthLink>
        {/snippet}
    </AuthCard>
{/if}
