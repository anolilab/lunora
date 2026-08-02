<script lang="ts">
    import { queryParameter } from "../core/browser-location";
    import { createResetPasswordController } from "../core/reset-password";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import Field from "./Field.svelte";
    import FormBanner from "./FormBanner.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    let { token }: { /** Defaults to `?token=` from the URL. */ token?: string } = $props();

    const t = useAuthUI().localization;
    // The reset token is read once at mount; navigate to a fresh route to reset.
    const { actions, state: form } = controllerStore((context) => createResetPasswordController(context, { token: token ?? queryParameter("token") }));
</script>

<AuthCard title={t.resetPassword}>
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
