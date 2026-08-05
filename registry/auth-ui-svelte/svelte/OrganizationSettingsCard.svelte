<script lang="ts">
    import { isFlowEnabled } from "../core/flow-gate";
    import { createOrganizationSettingsController } from "../core/organization-settings";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import FormField from "./FormField.svelte";
    import FormBanner from "./FormBanner.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    /** `organizationId` defaults to the user's active organization. */
    let { organizationId }: { organizationId?: string } = $props();

    const context = useAuthUI();
    const t = context.localization;
    const enabled = isFlowEnabled(context, "organization", "OrganizationSettingsCard");
    const { actions, state: form } = controllerStore((context_) => createOrganizationSettingsController(context_, { autoLoad: enabled, organizationId }));
</script>

{#if enabled}
    <AuthCard headingLevel={2} title={t.organizationSettings}>
        {#if $form.loading}
            <p class="lunora-auth-card__description">…</p>
        {:else}
            <form
                class="lunora-auth-form"
                novalidate
                onsubmit={(event) => {
                    event.preventDefault();
                    void actions.submit();
                }}
            >
                <FormBanner error={$form.formError} success={$form.successMessage} />
                <FormField {actions} field="name" fields={$form.fields} label={t.organizationName} name="organizationName" />
                <FormField {actions} field="slug" fields={$form.fields} label={t.organizationSlug} name="organizationSlug" />
                <FormField {actions} field="logo" fields={$form.fields} label={t.organizationLogo} name="organizationLogo" />
                <SubmitButton pending={$form.status === "submitting"}>{t.saveChanges}</SubmitButton>
            </form>
        {/if}
    </AuthCard>
{/if}
