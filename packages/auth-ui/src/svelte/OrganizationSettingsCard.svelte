<script lang="ts">
    import { createOrganizationSettingsController, isFlowEnabled } from "../core";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import Field from "./Field.svelte";
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
    <AuthCard title={t.organizationSettings}>
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
                <Field
                    field={$form.fields.name}
                    label={t.organizationName}
                    name="organizationName"
                    onBlur={() => {
                        actions.blur("name");
                    }}
                    onChange={(value) => {
                        actions.setField("name", value);
                    }}
                />
                <Field
                    field={$form.fields.slug}
                    label={t.organizationSlug}
                    name="organizationSlug"
                    onBlur={() => {
                        actions.blur("slug");
                    }}
                    onChange={(value) => {
                        actions.setField("slug", value);
                    }}
                />
                <Field
                    field={$form.fields.logo}
                    label={t.organizationLogo}
                    name="organizationLogo"
                    onBlur={() => {
                        actions.blur("logo");
                    }}
                    onChange={(value) => {
                        actions.setField("logo", value);
                    }}
                />
                <SubmitButton pending={$form.status === "submitting"}>{t.saveChanges}</SubmitButton>
            </form>
        {/if}
    </AuthCard>
{/if}
