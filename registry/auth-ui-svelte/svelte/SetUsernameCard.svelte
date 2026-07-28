<!-- Claim or change the username, when the `username` plugin is on. -->
<script lang="ts">
    import { isFlowEnabled } from "../core/flow-gate";
    import { createSetUsernameController } from "../core/username";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import Field from "./Field.svelte";
    import FormBanner from "./FormBanner.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    const context = useAuthUI();
    const t = context.localization;
    const enabled = isFlowEnabled(context, "username", "SetUsernameCard");
    const { actions, state: form } = controllerStore(createSetUsernameController);
</script>

{#if enabled}
    <AuthCard title={t.usernameLabel}>
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
                autoComplete="username"
                field={$form.fields.username}
                label={t.usernameLabel}
                name="username"
                onBlur={() => {
                    actions.blur("username");
                }}
                onChange={(value) => {
                    actions.setField("username", value);
                }}
            />
            <SubmitButton pending={$form.status === "submitting"}>{t.saveChanges}</SubmitButton>
        </form>
    </AuthCard>
{/if}
