<script lang="ts">
    import { createBackupCodeSignInController } from "../core/backup-codes";
    import { isFlowEnabled } from "../core/flow-gate";
    import { createTwoFactorVerifyController } from "../core/two-factor-verify";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import FormField from "./FormField.svelte";
    import FormBanner from "./FormBanner.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    let {
        method,
        trustDevice,
    }: {
        method?: "otp" | "totp";
        trustDevice?: boolean;
    } = $props();

    const context = useAuthUI();
    const t = context.localization;
    const enabled = isFlowEnabled(context, "twoFactor", "TwoFactorCard");
    // `method` / `trustDevice` are read once at mount.
    const { actions, state: form } = controllerStore((context) => createTwoFactorVerifyController(context, { method, trustDevice }));
    // Both controllers stay live regardless of which form is showing — a
    // session-mutating submit must not depend on the toggle's current position.
    const { actions: backupActions, state: backupForm } = controllerStore((context) => createBackupCodeSignInController(context, { trustDevice }));

    let useBackupCode = $state(false);
</script>

{#if enabled && useBackupCode}
    <AuthCard title={t.twoFactor}>
        <form
            class="lunora-auth-form"
            novalidate
            onsubmit={(event) => {
                event.preventDefault();
                void backupActions.submit();
            }}
        >
            <FormBanner error={$backupForm.formError} />
            <FormField actions={backupActions} autoComplete="one-time-code" field="code" fields={$backupForm.fields} label={t.backupCodeLabel} />
            <SubmitButton pending={$backupForm.status === "submitting"}>{t.twoFactor}</SubmitButton>
        </form>
        {#snippet footer()}
            <button
                class="lunora-auth-link"
                onclick={() => {
                    useBackupCode = false;
                }}
                type="button"
            >
                {t.twoFactorUseAuthenticator}
            </button>
        {/snippet}
    </AuthCard>
{:else if enabled}
    <AuthCard title={t.twoFactor}>
        <form
            class="lunora-auth-form"
            novalidate
            onsubmit={(event) => {
                event.preventDefault();
                void actions.submit();
            }}
        >
            <FormBanner error={$form.formError} />
            <FormField {actions} autoComplete="one-time-code" field="code" fields={$form.fields} label={t.codeLabel} />
            <SubmitButton pending={$form.status === "submitting"}>{t.twoFactor}</SubmitButton>
        </form>
        {#snippet footer()}
            <button
                class="lunora-auth-link"
                onclick={() => {
                    useBackupCode = true;
                }}
                type="button"
            >
                {t.backupCodeSignIn}
            </button>
        {/snippet}
    </AuthCard>
{/if}
