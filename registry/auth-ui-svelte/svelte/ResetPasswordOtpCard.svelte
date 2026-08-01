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
    import Field from "./Field.svelte";
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
        <Field
            autoComplete="email"
            field={$form.fields.email}
            label={t.emailLabel}
            name="email"
            onBlur={() => {
                actions.blur("email");
            }}
            onChange={(value) => {
                actions.setField("email", value);
            }}
            type="email"
        />
        <Field
            autoComplete="one-time-code"
            field={$form.fields.otp}
            label={t.codeLabel}
            name="otp"
            onBlur={() => {
                actions.blur("otp");
            }}
            onChange={(value) => {
                actions.setField("otp", value);
            }}
        />
        <Field
            autoComplete="new-password"
            field={$form.fields.password}
            label={t.passwordLabel}
            name="password"
            onBlur={() => {
                actions.blur("password");
            }}
            onChange={(value) => {
                actions.setField("password", value);
            }}
            type="password"
        />
        <Field
            autoComplete="new-password"
            field={$form.fields.confirmPassword}
            label={t.confirmPasswordLabel}
            name="confirmPassword"
            onBlur={() => {
                actions.blur("confirmPassword");
            }}
            onChange={(value) => {
                actions.setField("confirmPassword", value);
            }}
            type="password"
        />
        <SubmitButton pending={$form.status === "submitting"}>{t.resetPassword}</SubmitButton>
    </form>
</AuthCard>
