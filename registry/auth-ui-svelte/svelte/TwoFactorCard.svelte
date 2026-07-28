<script lang="ts">
    import { isFlowEnabled } from "../core/flow-gate";
    import { createTwoFactorVerifyController } from "../core/two-factor-verify";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import Field from "./Field.svelte";
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
</script>

{#if enabled}
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
            <Field
                autoComplete="one-time-code"
                field={$form.fields.code}
                label={t.codeLabel}
                name="code"
                onBlur={() => {
                    actions.blur("code");
                }}
                onChange={(value) => {
                    actions.setField("code", value);
                }}
            />
            <SubmitButton pending={$form.status === "submitting"}>{t.twoFactor}</SubmitButton>
        </form>
    </AuthCard>
{/if}
