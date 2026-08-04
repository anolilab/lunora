<!--
    Redeems an emailed one-time code instead of a link — for apps that set
    `forgotPassword: { method: "otp" }`. Unlike ResetPasswordCard, the email
    address is a field rather than something carried from the previous screen:
    a code can legitimately be redeemed from a fresh tab.
-->
<script lang="ts">
    import { createResetPasswordOtpController } from "../core/reset-password-otp";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import FormField from "./FormField.svelte";
    import FormBanner from "./FormBanner.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    const t = useAuthUI().localization;
    const { actions, state: form } = controllerStore((context) => createResetPasswordOtpController(context));
</script>

<AuthCard description={t.resetPasswordOtpDescription} title={t.resetPassword}>
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
        <FormField {actions} autoComplete="one-time-code" field="otp" fields={$form.fields} label={t.codeLabel} />
        <FormField {actions} autoComplete="new-password" field="password" fields={$form.fields} label={t.passwordLabel} type="password" />
        <FormField {actions} autoComplete="new-password" field="confirmPassword" fields={$form.fields} label={t.confirmPasswordLabel} type="password" />
        <SubmitButton pending={$form.status === "submitting"}>{t.resetPassword}</SubmitButton>
    </form>
</AuthCard>
