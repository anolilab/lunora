<!--
    The consent screen a third-party application redirects the user into.

    Deliberately plain: it names the application, lists exactly what it is asking
    for, and offers two equally-weighted answers. Nothing is pre-selected and
    there is no "remember this" shortcut — an authorization prompt that is easier
    to approve than to read is the failure mode this screen exists to avoid.
-->
<script lang="ts">
    import { isFlowEnabled } from "../core/flow-gate";
    import { createConsentController, scopeLabels } from "../core/oauth-provider";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import FormBanner from "./FormBanner.svelte";
    import { queryParameter } from "./query-parameter";
    import Skeleton from "./Skeleton.svelte";

    let {
        consentId,
    }: {
        /** Defaults to `?consent_id=` from the URL. */
        consentId?: string;
    } = $props();

    const context = useAuthUI();
    const t = context.localization;
    const enabled = isFlowEnabled(context, "oauthProvider", "ConsentCard");
    const { actions, state: flow } = controllerStore((context_) =>
        createConsentController(context_, { autoLoad: enabled, consentId: consentId ?? queryParameter("consent_id") }),
    );
</script>

{#if enabled}
    <AuthCard title={t.consentTitle}>
        <FormBanner error={$flow.error} />
        {#if $flow.loading}
            <Skeleton rows={3} />
        {:else if $flow.request !== undefined}
            <p class="lunora-auth-note"><strong>{$flow.request?.clientName ?? $flow.request?.clientId}</strong> {t.consentWants}</p>
            <ul class="lunora-auth-list">
                {#each scopeLabels($flow.request?.scope) as scope (scope)}
                    <li class="lunora-auth-list__item">
                        <span class="lunora-auth-list__label">{scope}</span>
                    </li>
                {/each}
            </ul>
            <div class="lunora-auth-actions">
                <!-- Deny first in the DOM: it is the safe answer, so it is the one a keyboard reaches first. -->
                <button
                    class="lunora-auth-button lunora-auth-button--secondary"
                    disabled={$flow.status === "submitting"}
                    onclick={() => {
                        void actions.deny();
                    }}
                    type="button"
                >
                    {t.consentDeny}
                </button>
                <button
                    class="lunora-auth-button"
                    disabled={$flow.status === "submitting"}
                    onclick={() => {
                        void actions.accept();
                    }}
                    type="button"
                >
                    {t.consentAllow}
                </button>
            </div>
        {/if}
    </AuthCard>
{/if}
