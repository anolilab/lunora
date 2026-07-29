<!--
  Test harness for the OAuth-provider cards: Svelte Testing Library renders one
  component, so this wraps the card under test in the provider (which must be an
  ancestor for the context to resolve) and states the `oauthProvider` gate
  explicitly rather than leaning on what the client registered.
-->
<script lang="ts">
    import type { AuthUIConfig } from "../../src/core";
    import AuthorizedAppsCard from "../../src/svelte/AuthorizedAppsCard.svelte";
    import AuthUIProvider from "../../src/svelte/AuthUIProvider.svelte";
    import ConsentCard from "../../src/svelte/ConsentCard.svelte";

    let {
        authClient,
        card,
        consentId,
        nav,
        oauthProvider = true,
    }: {
        authClient: AuthUIConfig["authClient"];
        card: "authorized-apps" | "consent";
        consentId?: string;
        nav: AuthUIConfig["nav"];
        oauthProvider?: boolean;
    } = $props();
</script>

<AuthUIProvider {authClient} discover={false} {nav} plugins={{ oauthProvider }}>
    {#if card === "consent"}
        <ConsentCard {consentId} />
    {:else}
        <AuthorizedAppsCard />
    {/if}
</AuthUIProvider>
