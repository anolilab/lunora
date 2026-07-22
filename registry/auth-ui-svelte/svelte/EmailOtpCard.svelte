<script lang="ts">
    import { createEmailOtpController } from "../core";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import Field from "./Field.svelte";
    import FormBanner from "./FormBanner.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    const t = useAuthUI().localization;
    const { actions, state: flow } = controllerStore(createEmailOtpController);
</script>

{#if $flow.step === "verify"}
    <AuthCard description={t.emailOtpSent} title={t.emailOtp}>
        <form
            class="lunora-auth-form"
            novalidate
            onsubmit={(event) => {
                event.preventDefault();
                void actions.verify();
            }}
        >
            <FormBanner error={$flow.formError} />
            <Field autoComplete="one-time-code" field={$flow.code} label={t.codeLabel} name="code" onBlur={() => {}} onChange={actions.setCode} />
            <SubmitButton pending={$flow.status === "submitting"}>{t.twoFactor}</SubmitButton>
        </form>
        {#snippet footer()}
            <button class="lunora-auth-link" onclick={actions.back} type="button">{t.sendNewCode}</button>
        {/snippet}
    </AuthCard>
{:else}
    <AuthCard title={t.emailOtp}>
        <form
            class="lunora-auth-form"
            novalidate
            onsubmit={(event) => {
                event.preventDefault();
                void actions.sendCode();
            }}
        >
            <FormBanner error={$flow.formError} success={$flow.successMessage} />
            <Field autoComplete="email" field={$flow.email} label={t.emailLabel} name="email" onBlur={() => {}} onChange={actions.setEmail} type="email" />
            <SubmitButton pending={$flow.status === "submitting"}>{t.emailOtp}</SubmitButton>
        </form>
    </AuthCard>
{/if}
