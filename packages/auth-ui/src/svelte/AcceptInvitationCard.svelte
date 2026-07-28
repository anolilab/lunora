<!--
    The screen an organization invitation link lands on.

    It renders the organization's name before asking for a decision — an "Accept"
    button with nothing above it is not consent — and bounces through sign-in when
    there is no session, returning to this same invitation afterwards.
-->
<script lang="ts">
    import { createAcceptInvitationController } from "../core/invitations";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import FormBanner from "./FormBanner.svelte";
    import { queryParameter } from "./query-parameter";
    import Skeleton from "./Skeleton.svelte";

    let {
        invitationId,
    }: {
        /** Defaults to `?invitationId=` from the URL. */
        invitationId?: string;
    } = $props();

    const t = useAuthUI().localization;
    const { actions, state: flow } = controllerStore((context) =>
        createAcceptInvitationController(context, { invitationId: invitationId ?? queryParameter("invitationId") }),
    );
</script>

<AuthCard description={$flow.invitation?.organizationName} title={t.invitationTitle}>
    <FormBanner error={$flow.error} />
    {#if $flow.loading}
        <Skeleton rows={2} />
    {:else}
        <div class="lunora-auth-actions">
            <button
                class="lunora-auth-button"
                disabled={$flow.status === "submitting" || $flow.invitation === undefined}
                onclick={() => {
                    void actions.accept();
                }}
                type="button"
            >
                {t.invitationAccept}
            </button>
            <button
                class="lunora-auth-button lunora-auth-button--secondary"
                disabled={$flow.status === "submitting" || $flow.invitation === undefined}
                onclick={() => {
                    void actions.reject();
                }}
                type="button"
            >
                {t.invitationReject}
            </button>
        </div>
    {/if}
</AuthCard>
