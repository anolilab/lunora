<!-- "Send me another link" — the companion to <VerifyEmailCard>. -->
<script lang="ts">
    import { createResendVerificationController } from "../core/verify-email";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import FormField from "./FormField.svelte";
    import FormBanner from "./FormBanner.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    const t = useAuthUI().localization;
    const { actions, state: form } = controllerStore(createResendVerificationController);
</script>

<AuthCard title={t.verifyEmail}>
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
        <SubmitButton pending={$form.status === "submitting"}>{t.verifyEmailResend}</SubmitButton>
    </form>
</AuthCard>
