<!-- Claim or change the username, when the `username` plugin is on. -->
<script lang="ts">
    import { isFlowEnabled } from "../core/flow-gate";
    import { createSetUsernameController } from "../core/username";
    import { createUsernameAvailabilityController } from "../core/username-availability";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import Field from "./Field.svelte";
    import FormBanner from "./FormBanner.svelte";
    import SubmitButton from "./SubmitButton.svelte";
    import UsernameAvailability from "./UsernameAvailability.svelte";

    const context = useAuthUI();
    const t = context.localization;
    const enabled = isFlowEnabled(context, "username", "SetUsernameCard");
    const { actions, state: form } = controllerStore(createSetUsernameController);
    // Checked as the user types, so a taken name surfaces here rather than as a
    // failed save with the field already blurred.
    const { actions: availabilityActions, state: availability } = controllerStore(createUsernameAvailabilityController);
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
                    availabilityActions.check(value);
                }}
            />
            <UsernameAvailability status={$availability.status} />
            <SubmitButton pending={$form.status === "submitting"}>{t.saveChanges}</SubmitButton>
        </form>
    </AuthCard>
{/if}
