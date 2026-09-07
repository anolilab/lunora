<script lang="ts">
    import { onMount } from "svelte";
    import { viewHref } from "../core/config";
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

    let {
        signInHref,
    }: {
        /** Defaults to the configured sign-in route; see `viewPaths.base`. */
        signInHref?: string;
    } = $props();

    const context = useAuthUI();
    const signInLink = $derived(signInHref ?? viewHref(context, "signIn"));
    const t = context.localization;
    const enabled = isFlowEnabled(context, "magicLink", "MagicLinkCard");
    const { actions, state: form } = controllerStore(createMagicLinkController);
    // Read after mount, not at initialisation: the server has no cookie, so a
    // render-time read is a hydration mismatch. See `lastLoginMethodStore`.
    let lastUsedAfterMount = $state<string | undefined>(undefined);

    onMount(() => {
        lastUsedAfterMount = readLastLoginMethod();
    });

    const lastUsed = $derived(context.plugins.lastLoginMethod ? lastUsedAfterMount : undefined);
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
            <AuthLink href={signInLink}>{t.backToSignIn}</AuthLink>
        {/snippet}
    </AuthCard>
{/if}
