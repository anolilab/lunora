<script lang="ts">
    import { createDeleteAccountController } from "../core/delete-account";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import FormField from "./FormField.svelte";
    import FormBanner from "./FormBanner.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    const t = useAuthUI().localization;
    const { actions, state: form } = controllerStore(createDeleteAccountController);
</script>

<AuthCard description={t.deleteAccountWarning} headingLevel={2} title={t.deleteAccount}>
    <form
        class="lunora-auth-form"
        novalidate
        onsubmit={(event) => {
            event.preventDefault();
            void actions.submit();
        }}
    >
        <FormBanner error={$form.formError} />
        <FormField {actions} autoComplete="current-password" field="password" fields={$form.fields} label={t.passwordLabel} type="password" />
        <SubmitButton pending={$form.status === "submitting"}>{t.deleteAccount}</SubmitButton>
    </form>
</AuthCard>
