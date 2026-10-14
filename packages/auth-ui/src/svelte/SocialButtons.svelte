<!--
    OAuth provider buttons. Rendered only when there are providers — which, with
    server discovery on, is whatever `socialProviders` the deployment configured.

    The provider's brand mark is left to CSS: each button carries a
    `lunora-auth-social__icon--<provider>` class, so an app drops in its own icon
    set with a stylesheet rule and this package ships no SVG payload for a list of
    providers it can't know in advance.
-->
<script lang="ts">
    import { providerLabel } from "../core/labels";
    import { useAuthUI } from "./context";

    let {
        lastUsed,
        onSelect,
        providers,
    }: {
        /** Highlight the provider used last on this device, when known. */
        lastUsed?: string;
        onSelect: (provider: string) => void;
        providers: ReadonlyArray<string>;
    } = $props();

    const t = useAuthUI().localization;
</script>

{#if providers.length > 0}
    <div class="lunora-auth-social">
        {#each providers as provider (provider)}
            <button
                class="lunora-auth-button lunora-auth-button--secondary lunora-auth-social__button"
                onclick={() => {
                    onSelect(provider);
                }}
                type="button"
            >
                <span aria-hidden="true" class="lunora-auth-social__icon lunora-auth-social__icon--{provider}"></span>
                <span class="lunora-auth-social__label">{t.signInWith} {providerLabel(provider)}</span>
                {#if lastUsed === provider}
                    <span class="lunora-auth-social__badge">{t.lastUsed}</span>
                {/if}
            </button>
        {/each}
    </div>
{/if}
