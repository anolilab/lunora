<!--
  Test harness: Svelte Testing Library renders one component, so this wraps the
  card under test in the provider (which must be an ancestor for the context to
  resolve).
-->
<script lang="ts">
    import type { AuthUIConfig } from "../../src/core";
    import AuthUIProvider from "../../src/svelte/AuthUIProvider.svelte";
    import MagicLinkCard from "../../src/svelte/MagicLinkCard.svelte";
    import SignInCard from "../../src/svelte/SignInCard.svelte";

    let {
        authClient,
        card,
        nav,
        theme,
    }: {
        authClient: AuthUIConfig["authClient"];
        card: "magic-link" | "sign-in";
        nav: AuthUIConfig["nav"];
        theme?: AuthUIConfig["theme"];
    } = $props();
</script>

<AuthUIProvider {authClient} {nav} {theme}>
    {#if card === "sign-in"}
        <SignInCard />
    {:else}
        <MagicLinkCard />
    {/if}
</AuthUIProvider>
