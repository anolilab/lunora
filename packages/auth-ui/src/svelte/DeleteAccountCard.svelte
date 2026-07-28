<script lang="ts">
    import { createDeleteAccountController } from "../core/delete-account";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import Field from "./Field.svelte";
    import FormBanner from "./FormBanner.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    const t = useAuthUI().localization;
    const { actions, state: form } = controllerStore(createDeleteAccountController);
</script>

<AuthCard description={t.deleteAccountWarning} title={t.deleteAccount}>
    <form
        class="lunora-auth-form"
        novalidate
        onsubmit={(event) => {
            event.preventDefault();
            void actions.submit();
        }}
    >
        <FormBanner error={$form.formError} />
        <Field
            autoComplete="current-password"
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
        <SubmitButton pending={$form.status === "submitting"}>{t.deleteAccount}</SubmitButton>
    </form>
</AuthCard>
