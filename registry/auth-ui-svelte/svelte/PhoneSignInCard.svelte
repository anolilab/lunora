<!-- Sign in with a phone number and password. -->
<script lang="ts">
    import { isFlowEnabled } from "../core/flow-gate";
    import { createPhoneSignInController } from "../core/phone-number";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import FormField from "./FormField.svelte";
    import FormBanner from "./FormBanner.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    const context = useAuthUI();
    const t = context.localization;
    const enabled = isFlowEnabled(context, "phoneNumber", "PhoneSignInCard");
    const { actions, state: form } = controllerStore(createPhoneSignInController);
</script>

{#if enabled}
    <AuthCard title={t.signIn}>
        <form
            class="lunora-auth-form"
            novalidate
            onsubmit={(event) => {
                event.preventDefault();
                void actions.submit();
            }}
        >
            <FormBanner error={$form.formError} />
            <FormField {actions} autoComplete="tel" field="phoneNumber" fields={$form.fields} label={t.phoneLabel} />
            <FormField {actions} autoComplete="current-password" field="password" fields={$form.fields} label={t.passwordLabel} type="password" />
            <SubmitButton pending={$form.status === "submitting"}>{t.signIn}</SubmitButton>
        </form>
    </AuthCard>
{/if}
