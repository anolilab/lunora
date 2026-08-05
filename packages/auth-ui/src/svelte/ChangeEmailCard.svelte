<script lang="ts">
    import { createChangeEmailController } from "../core/change-email";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import FormField from "./FormField.svelte";
    import FormBanner from "./FormBanner.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    const t = useAuthUI().localization;
    const { actions, state: form } = controllerStore(createChangeEmailController);
</script>

<AuthCard headingLevel={2} title={t.changeEmail}>
    <form
        class="lunora-auth-form"
        novalidate
        onsubmit={(event) => {
            event.preventDefault();
            void actions.submit();
        }}
    >
        <FormBanner error={$form.formError} success={$form.successMessage} />
        <FormField {actions} autoComplete="email" field="newEmail" fields={$form.fields} label={t.newEmailLabel} type="email" />
        <SubmitButton pending={$form.status === "submitting"}>{t.changeEmail}</SubmitButton>
    </form>
</AuthCard>
