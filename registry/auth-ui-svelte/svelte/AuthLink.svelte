<!-- Internal link using the provider's framework `Link` when present, else <a>. -->
<script lang="ts">
    import type { Snippet } from "svelte";

    import { useAuthUILink } from "./context";

    let {
        children,
        href,
    }: {
        children: Snippet;
        href: string;
    } = $props();

    const Link = useAuthUILink();
</script>

{#if Link}
    <Link class="lunora-auth-link" {href}>{@render children()}</Link>
{:else}
    <a class="lunora-auth-link" {href}>{@render children()}</a>
{/if}
