<script lang="ts">
    import { isFlowEnabled } from "../core/flow-gate";
    import { createTwoFactorSetupController, totpSecret } from "../core/two-factor-setup";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import Field from "./Field.svelte";
    import FormBanner from "./FormBanner.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    const context = useAuthUI();
    const t = context.localization;
    const enabled = isFlowEnabled(context, "twoFactor", "TwoFactorSetupCard");
    const { actions, state: flow } = controllerStore(createTwoFactorSetupController);
    const secret = $derived(totpSecret($flow.totpUri));
</script>

{#if enabled}
    {#if $flow.step === "enabled"}
        <AuthCard title={t.twoFactorSetup}>
            <FormBanner error={$flow.error} success={t.twoFactorEnabled} />
            <form
                class="lunora-auth-form"
                novalidate
                onsubmit={(event) => {
                    event.preventDefault();
                    void actions.disable();
                }}
            >
                <Field
                    autoComplete="current-password"
                    field={$flow.password}
                    label={t.passwordLabel}
                    name="password"
                    onBlur={() => {}}
                    onChange={actions.setPassword}
                    type="password"
                />
                <SubmitButton pending={$flow.status === "submitting"}>{t.twoFactorDisable}</SubmitButton>
            </form>
        </AuthCard>
    {:else if $flow.step === "verify"}
        <AuthCard description={t.twoFactorScan} title={t.twoFactorSetup}>
            <FormBanner error={$flow.error} />
            <!--
                The setup key, not the raw `otpauth://…` URI: this package
                ships no QR encoder, so there is nothing to scan, and most
                authenticators reject a pasted `otpauth://…` string anyway —
                the key is the only path that reliably works.
            -->
            {#if secret !== undefined}
                <p class="lunora-auth-note">{t.twoFactorSecret}</p>
                <code class="lunora-auth-code">{secret}</code>
            {/if}
            {#if $flow.backupCodes.length > 0}
                <p class="lunora-auth-card__description">{t.backupCodes}</p>
                <ul class="lunora-auth-codes">
                    {#each $flow.backupCodes as backupCode (backupCode)}
                        <li class="lunora-auth-codes__item">{backupCode}</li>
                    {/each}
                </ul>
            {/if}
            <form
                class="lunora-auth-form"
                novalidate
                onsubmit={(event) => {
                    event.preventDefault();
                    void actions.verify();
                }}
            >
                <Field autoComplete="one-time-code" field={$flow.code} label={t.codeLabel} name="code" onBlur={() => {}} onChange={actions.setCode} />
                <SubmitButton pending={$flow.status === "submitting"}>{t.twoFactor}</SubmitButton>
            </form>
        </AuthCard>
    {:else}
        <AuthCard title={t.twoFactorSetup}>
            <FormBanner error={$flow.error} />
            <form
                class="lunora-auth-form"
                novalidate
                onsubmit={(event) => {
                    event.preventDefault();
                    void actions.enable();
                }}
            >
                <Field
                    autoComplete="current-password"
                    field={$flow.password}
                    label={t.passwordLabel}
                    name="password"
                    onBlur={() => {}}
                    onChange={actions.setPassword}
                    type="password"
                />
                <SubmitButton pending={$flow.status === "submitting"}>{t.twoFactorEnable}</SubmitButton>
            </form>
        </AuthCard>
    {/if}
{/if}
