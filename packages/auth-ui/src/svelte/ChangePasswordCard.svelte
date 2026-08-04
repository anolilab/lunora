<script lang="ts">
    import { createChangePasswordController } from "../core/change-password";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import FormField from "./FormField.svelte";
    import FormBanner from "./FormBanner.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    const t = useAuthUI().localization;
    const { actions, state: form } = controllerStore(createChangePasswordController);
</script>

<AuthCard headingLevel={2} title={t.changePassword}>
    <form
        class="lunora-auth-form"
        novalidate
        onsubmit={(event) => {
            event.preventDefault();
            void actions.submit();
        }}
    >
        <FormBanner error={$form.formError} success={$form.successMessage} />
        <FormField {actions} autoComplete="current-password" field="currentPassword" fields={$form.fields} label={t.currentPasswordLabel} type="password" />
        <FormField {actions} autoComplete="new-password" field="newPassword" fields={$form.fields} label={t.newPasswordLabel} type="password" />
        <FormField {actions} autoComplete="new-password" field="confirmPassword" fields={$form.fields} label={t.confirmPasswordLabel} type="password" />
        <SubmitButton pending={$form.status === "submitting"}>{t.changePassword}</SubmitButton>
    </form>
</AuthCard>
