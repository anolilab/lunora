<!--
    Regenerate two-factor backup codes.

    The new codes are shown once and never again — they are not refetchable by
    design — so they render inline on success rather than behind a navigation the
    user might not come back from.
-->
<script lang="ts">
    import { createBackupCodesController } from "../core/backup-codes";
    import { isFlowEnabled } from "../core/flow-gate";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import FormField from "./FormField.svelte";
    import FormBanner from "./FormBanner.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    const context = useAuthUI();
    const t = context.localization;
    const enabled = isFlowEnabled(context, "twoFactor", "BackupCodesCard");
    // The codes live beside the form controller rather than inside it (see
    // `backup-codes.ts`), so the handle is created here and its controller handed
    // to the store seam — which still owns creation and disposal.
    const handle = createBackupCodesController(context);
    const { actions, state: form } = controllerStore(() => handle.controller);

    let codes = $state<ReadonlyArray<string>>(handle.getCodes());
</script>

{#if enabled}
    <AuthCard title={t.backupCodesRegenerate}>
        <form
            class="lunora-auth-form"
            novalidate
            onsubmit={(event) => {
                event.preventDefault();
                void actions.submit().then(() => {
                    codes = handle.getCodes();
                });
            }}
        >
            <FormBanner error={$form.formError} success={$form.successMessage} />
            <FormField {actions} autoComplete="current-password" field="password" fields={$form.fields} label={t.currentPasswordLabel} type="password" />
            <SubmitButton pending={$form.status === "submitting"}>{t.backupCodesRegenerate}</SubmitButton>
        </form>
        {#if codes.length > 0}
            <p class="lunora-auth-note">{t.backupCodes}</p>
            <ul class="lunora-auth-codes">
                {#each codes as code (code)}
                    <li class="lunora-auth-codes__item">{code}</li>
                {/each}
            </ul>
        {/if}
    </AuthCard>
{/if}
