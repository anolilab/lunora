<!-- OAuth provider buttons. Rendered only when the caller passes providers. -->
<script lang="ts">
    let {
        onSelect,
        providers,
    }: {
        onSelect: (provider: string) => void;
        providers: ReadonlyArray<string>;
    } = $props();

    const labelFor = (provider: string): string => provider.charAt(0).toUpperCase() + provider.slice(1);
</script>

{#if providers.length > 0}
    <div class="lunora-auth-social">
        {#each providers as provider (provider)}
            <button
                class="lunora-auth-button lunora-auth-button--secondary"
                onclick={() => {
                    onSelect(provider);
                }}
                type="button"
            >
                Continue with {labelFor(provider)}
            </button>
        {/each}
    </div>
{/if}
