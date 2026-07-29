<!-- Every invitation waiting for the signed-in user, decidable in place. -->
<script lang="ts">
    import { createUserInvitationsController } from "../core/invitations";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import FormBanner from "./FormBanner.svelte";
    import Skeleton from "./Skeleton.svelte";

    const t = useAuthUI().localization;
    const { actions, state: res } = controllerStore(createUserInvitationsController);
</script>

<AuthCard title={t.invitations}>
    <FormBanner error={$res.error} />
    {#if $res.loading}
        <Skeleton rows={2} />
    {:else}
        <ul class="lunora-auth-list">
            {#each $res.items as invitation (invitation.id)}
                <li class="lunora-auth-list__item">
                    <span class="lunora-auth-list__label">{invitation.organizationName ?? invitation.email}</span>
                    <span class="lunora-auth-list__actions">
                        <button
                            class="lunora-auth-button"
                            disabled={$res.busy}
                            onclick={() => {
                                void actions.accept(invitation.id ?? "");
                            }}
                            type="button"
                        >
                            {t.invitationAccept}
                        </button>
                        <button
                            class="lunora-auth-button lunora-auth-button--secondary"
                            disabled={$res.busy}
                            onclick={() => {
                                void actions.reject(invitation.id ?? "");
                            }}
                            type="button"
                        >
                            {t.invitationReject}
                        </button>
                    </span>
                </li>
            {/each}
            {#if $res.items.length === 0}
                <li class="lunora-auth-list__empty">{t.invitationsEmpty}</li>
            {/if}
        </ul>
    {/if}
</AuthCard>
