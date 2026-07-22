<script lang="ts">
    import { createChangePasswordController } from "../core";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import Field from "./Field.svelte";
    import FormBanner from "./FormBanner.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    const t = useAuthUI().localization;
    const { actions, state: form } = controllerStore(createChangePasswordController);
</script>

<AuthCard title={t.changePassword}>
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
            autoComplete="current-password"
            field={$form.fields.currentPassword}
            label={t.currentPasswordLabel}
            name="currentPassword"
            onBlur={() => {
                actions.blur("currentPassword");
            }}
            onChange={(value) => {
                actions.setField("currentPassword", value);
            }}
            type="password"
        />
        <Field
            autoComplete="new-password"
            field={$form.fields.newPassword}
            label={t.newPasswordLabel}
            name="newPassword"
            onBlur={() => {
                actions.blur("newPassword");
            }}
            onChange={(value) => {
                actions.setField("newPassword", value);
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
        <SubmitButton pending={$form.status === "submitting"}>{t.changePassword}</SubmitButton>
    </form>
</AuthCard>
