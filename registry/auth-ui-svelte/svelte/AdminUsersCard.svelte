<!--
    The admin plugin's user table.

    Every action here is destructive or privilege-changing, so none of them are
    optimistic and none are one click from a row's primary target — impersonation
    in particular navigates away rather than mutating in place, because the whole
    app is a different user afterwards.
-->
<script lang="ts">
    import { createAdminUsersController } from "../core/admin-users";
    import { isFlowEnabled } from "../core/flow-gate";
    import { ROLE_OPTIONS } from "../core/labels";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import FormBanner from "./FormBanner.svelte";
    import Skeleton from "./Skeleton.svelte";

    const context = useAuthUI();
    const t = context.localization;
    const enabled = isFlowEnabled(context, "admin", "AdminUsersCard");
    const { actions, state: res } = controllerStore((context_) => createAdminUsersController(context_, { autoLoad: enabled }));

    const roles = ["user", ...ROLE_OPTIONS];
</script>

{#if enabled}
    <AuthCard title={t.adminTitle}>
        <FormBanner error={$res.error} />
        <input
            aria-label={t.adminSearch}
            class="lunora-auth-field__input"
            oninput={(event) => {
                void actions.setSearch(event.currentTarget.value);
            }}
            placeholder={t.adminSearch}
            type="search"
            value={$res.extra.search}
        />
        {#if $res.loading}
            <Skeleton />
        {:else}
            <ul class="lunora-auth-list">
                {#each $res.items as user (user.id)}
                    <li class="lunora-auth-list__item">
                        <span class="lunora-auth-list__label">
                            {user.email}
                            {#if user.banned === true}
                                <span class="lunora-auth-badge">{t.adminBan}</span>
                            {/if}
                        </span>
                        <span class="lunora-auth-list__actions">
                            <select
                                aria-label={t.roleLabel}
                                class="lunora-auth-select"
                                disabled={$res.busy}
                                onchange={(event) => {
                                    void actions.setRole(user.id ?? "", event.currentTarget.value);
                                }}
                                value={user.role ?? "user"}
                            >
                                {#each roles as role (role)}
                                    <option value={role}>{role}</option>
                                {/each}
                            </select>
                            <button
                                class="lunora-auth-button lunora-auth-button--secondary"
                                disabled={$res.busy}
                                onclick={() => {
                                    void actions.impersonate(user.id ?? "");
                                }}
                                type="button"
                            >
                                {t.adminImpersonate}
                            </button>
                            <button
                                class="lunora-auth-button lunora-auth-button--danger"
                                disabled={$res.busy}
                                onclick={() => {
                                    void (user.banned === true ? actions.unban(user.id ?? "") : actions.ban(user.id ?? ""));
                                }}
                                type="button"
                            >
                                {user.banned === true ? t.adminUnban : t.adminBan}
                            </button>
                        </span>
                    </li>
                {/each}
                {#if $res.items.length === 0}
                    <li class="lunora-auth-list__empty">{t.adminUsersEmpty}</li>
                {/if}
            </ul>
        {/if}
    </AuthCard>
{/if}
