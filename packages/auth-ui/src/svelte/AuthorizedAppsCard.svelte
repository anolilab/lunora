<!--
    Applications the user has authorized, with revoke — the place a granted
    consent can be taken back. Without it, the consent screen is a one-way door.
-->
<script lang="ts">
    import { isFlowEnabled } from "../core/flow-gate";
    import { createAuthorizedAppsController } from "../core/oauth-provider";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import FormBanner from "./FormBanner.svelte";
    import Skeleton from "./Skeleton.svelte";

    const context = useAuthUI();
    const t = context.localization;
    const enabled = isFlowEnabled(context, "oauthProvider", "AuthorizedAppsCard");
    const { actions, state: res } = controllerStore((context_) => createAuthorizedAppsController(context_, { autoLoad: enabled }));
</script>

{#if enabled}
    <AuthCard title={t.authorizedApps}>
        <FormBanner error={$res.error} />
        {#if $res.loading}
            <Skeleton rows={2} />
        {:else}
            <ul class="lunora-auth-list">
                {#each $res.items as consent (consent.id ?? consent.clientId)}
                    <li class="lunora-auth-list__item">
                        <span class="lunora-auth-list__label">{consent.clientName ?? consent.clientId}</span>
                        <button
                            class="lunora-auth-button lunora-auth-button--danger"
                            disabled={$res.busy}
                            onclick={() => {
                                void actions.revoke(consent.id ?? "");
                            }}
                            type="button"
                        >
                            {t.revokeAccess}
                        </button>
                    </li>
                {/each}
                {#if $res.items.length === 0}
                    <li class="lunora-auth-list__empty">{t.authorizedAppsEmpty}</li>
                {/if}
            </ul>
        {/if}
    </AuthCard>
{/if}
