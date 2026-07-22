<script lang="ts">
    import { createChangeEmailController } from "../core";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import Field from "./Field.svelte";
    import FormBanner from "./FormBanner.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    const t = useAuthUI().localization;
    const { actions, state: form } = controllerStore(createChangeEmailController);
</script>

<AuthCard title={t.changeEmail}>
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
            field={$form.fields.newEmail}
            label={t.newEmailLabel}
            name="newEmail"
            onBlur={() => {
                actions.blur("newEmail");
            }}
            onChange={(value) => {
                actions.setField("newEmail", value);
            }}
            type="email"
        />
        <SubmitButton pending={$form.status === "submitting"}>{t.changeEmail}</SubmitButton>
    </form>
</AuthCard>
