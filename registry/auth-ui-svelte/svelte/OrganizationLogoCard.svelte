<!--
    Upload an organization's logo. Rendered only when the app configured an
    `avatar.upload` handler — without one, <OrganizationSettingsCard>'s logo URL
    field is the fallback.
-->
<script lang="ts">
    import { ACCEPT_ATTRIBUTE } from "../core/avatar";
    import { createOrganizationLogoController } from "../core/organization-logo";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import FormBanner from "./FormBanner.svelte";

    /** `organizationId` defaults to the user's active organization. */
    let { organizationId }: { organizationId?: string } = $props();

    const context = useAuthUI();
    const t = context.localization;
    const { actions, state: logo } = controllerStore((context_) => createOrganizationLogoController(context_, { organizationId }));

    let picker = $state<HTMLInputElement | undefined>(undefined);
</script>

{#if context.avatar.upload !== undefined && context.plugins.organization}
    <AuthCard title={t.organizationLogo}>
        <FormBanner error={$logo.error} />
        <div class="lunora-auth-avatar-row">
            {#if $logo.logoUrl === undefined || $logo.logoUrl === ""}
                <span aria-hidden="true" class="lunora-auth-avatar lunora-auth-avatar--initials"></span>
            {:else}
                <img alt="" class="lunora-auth-avatar" src={$logo.logoUrl} />
            {/if}
            <div class="lunora-auth-avatar-row__actions">
                <input
                    accept={ACCEPT_ATTRIBUTE}
                    aria-label={t.avatarUpload}
                    bind:this={picker}
                    class="lunora-auth-visually-hidden"
                    onchange={(event) => {
                        const file = event.currentTarget.files?.[0];

                        // Clear the input so re-picking the same file after a
                        // failure still fires `change` — browsers suppress it when
                        // the value is unchanged.
                        event.currentTarget.value = "";

                        if (file) {
                            void actions.upload(file);
                        }
                    }}
                    type="file"
                />
                <button
                    class="lunora-auth-button"
                    disabled={$logo.status === "submitting"}
                    onclick={() => {
                        picker?.click();
                    }}
                    type="button"
                >
                    {t.avatarUpload}
                </button>
                {#if $logo.logoUrl !== undefined && $logo.logoUrl !== ""}
                    <button
                        class="lunora-auth-button lunora-auth-button--danger"
                        disabled={$logo.status === "submitting"}
                        onclick={() => {
                            void actions.remove();
                        }}
                        type="button"
                    >
                        {t.avatarRemove}
                    </button>
                {/if}
            </div>
        </div>
    </AuthCard>
{/if}
