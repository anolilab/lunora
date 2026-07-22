<script lang="ts">
    import type { AuthSession } from "../core";
    import { createSessionsController } from "../core";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import FormBanner from "./FormBanner.svelte";

    const t = useAuthUI().localization;
    const { actions, state: res } = controllerStore(createSessionsController);

    const sessionLabel = (session: AuthSession): string => {
        const agent = session.userAgent?.trim();

        return agent === undefined || agent === "" ? (session.ipAddress ?? "Unknown device") : agent;
    };
</script>

<AuthCard title={t.sessions}>
    <FormBanner error={$res.error} />
    {#if $res.loading}
        <p class="lunora-auth-card__description">…</p>
    {:else if $res.items.length === 0}
        <p class="lunora-auth-card__description">{t.sessionsEmpty}</p>
    {:else}
        <ul class="lunora-auth-list">
            {#each $res.items as session (session.id ?? session.token ?? sessionLabel(session))}
                <li class="lunora-auth-list__item">
                    <span class="lunora-auth-list__label">{sessionLabel(session)}</span>
                    {#if session.token !== undefined}
                        <button
                            class="lunora-auth-link"
                            disabled={$res.busy}
                            onclick={() => {
                                void actions.revoke(session.token);
                            }}
                            type="button"
                        >
                            {t.revoke}
                        </button>
                    {/if}
                </li>
            {/each}
        </ul>
    {/if}
    <button
        class="lunora-auth-button lunora-auth-button--secondary"
        disabled={$res.busy}
        onclick={() => {
            void actions.revokeOthers();
        }}
        type="button"
    >
        {t.revokeOthers}
    </button>
</AuthCard>
