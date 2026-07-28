<!--
    Which OAuth providers are attached, with link/unlink.

    The "available to link" list is `context.social` minus what is already
    attached — so with server discovery on, it is exactly the providers the
    deployment configured, and an app that adds one gets a new button with no
    client change.
-->
<script lang="ts">
    import { createAccountsController, NON_SOCIAL_PROVIDERS } from "../core/accounts";
    import { providerLabel } from "../core/labels";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import FormBanner from "./FormBanner.svelte";
    import Skeleton from "./Skeleton.svelte";

    const context = useAuthUI();
    const t = context.localization;
    const { actions, state: res } = controllerStore(createAccountsController);

    const linkable = $derived.by(() => {
        const linked = new Set($res.items.map((account) => account.providerId).filter((id): id is string => id !== undefined));

        return context.social.filter((provider) => !linked.has(provider));
    });
</script>

<AuthCard title={t.accountsTitle}>
    <FormBanner error={$res.error} />
    {#if $res.loading}
        <Skeleton />
    {:else}
        <ul class="lunora-auth-list">
            {#each $res.items as account (account.id ?? account.providerId)}
                <li class="lunora-auth-list__item">
                    <span class="lunora-auth-list__label">{providerLabel(account.providerId ?? "")}</span>
                    <!--
                        `credential` is the password and `passkey` rows belong to
                        <PasskeysCard>; offering "unlink" for either would be a
                        button that either fails or deletes the wrong thing.
                    -->
                    {#if !NON_SOCIAL_PROVIDERS.has(account.providerId ?? "")}
                        <button
                            class="lunora-auth-button lunora-auth-button--danger"
                            disabled={$res.busy || $res.items.length <= 1}
                            onclick={() => {
                                void actions.unlink(account.providerId ?? "", account.accountId);
                            }}
                            type="button"
                        >
                            {t.remove}
                        </button>
                    {/if}
                </li>
            {/each}
            {#if $res.items.length === 0}
                <li class="lunora-auth-list__empty">{t.accountsEmpty}</li>
            {/if}
        </ul>
    {/if}
    {#if linkable.length > 0}
        <div class="lunora-auth-social">
            {#each linkable as provider (provider)}
                <button
                    class="lunora-auth-button lunora-auth-button--secondary"
                    disabled={$res.busy}
                    onclick={() => {
                        void actions.link(provider);
                    }}
                    type="button"
                >
                    {t.accountsLink}: {providerLabel(provider)}
                </button>
            {/each}
        </div>
    {/if}
</AuthCard>
