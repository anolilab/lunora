<!--
    The accounts signed in on *this device*, with switch and sign-out-just-this.

    Not <SessionsCard>, which lists this account's sessions across every device.
    The two are a keystroke apart in better-auth's API and mean opposite things.
-->
<script lang="ts">
    import { isFlowEnabled } from "../core/flow-gate";
    import { createDeviceSessionsController } from "../core/multi-session";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import FormBanner from "./FormBanner.svelte";
    import Skeleton from "./Skeleton.svelte";
    import UserView from "./UserView.svelte";

    const context = useAuthUI();
    const t = context.localization;
    const enabled = isFlowEnabled(context, "multiSession", "MultiSessionCard");
    const { actions, state: res } = controllerStore((context_) => createDeviceSessionsController(context_, { autoLoad: enabled }));
</script>

{#if enabled}
    <AuthCard title={t.multiSessionTitle}>
        <FormBanner error={$res.error} />
        {#if $res.loading}
            <Skeleton rows={2} />
        {:else}
            <ul class="lunora-auth-list">
                {#each $res.items as entry (entry.session?.token ?? entry.user?.id)}
                    <li class="lunora-auth-list__item">
                        <UserView compact user={entry.user} />
                        <span class="lunora-auth-list__actions">
                            <button
                                class="lunora-auth-button lunora-auth-button--secondary"
                                disabled={$res.busy}
                                onclick={() => {
                                    void actions.setActive(entry.session?.token ?? "");
                                }}
                                type="button"
                            >
                                {t.switchAccount}
                            </button>
                            <button
                                class="lunora-auth-button lunora-auth-button--danger"
                                disabled={$res.busy}
                                onclick={() => {
                                    void actions.revoke(entry.session?.token ?? "");
                                }}
                                type="button"
                            >
                                {t.signOut}
                            </button>
                        </span>
                    </li>
                {/each}
                {#if $res.items.length === 0}
                    <li class="lunora-auth-list__empty">{t.multiSessionEmpty}</li>
                {/if}
            </ul>
        {/if}
    </AuthCard>
{/if}
