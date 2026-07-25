<!-- Card shell: heading, optional description, body, and optional footer. -->
<script lang="ts">
    import type { Snippet } from "svelte";

    import { useAuthUI } from "./context";

    let {
        children,
        description,
        footer,
        title,
    }: {
        children: Snippet;
        description?: string;
        footer?: Snippet;
        title: string;
    } = $props();

    // Only set when the app configured `theme` — otherwise the app's own design
    // tokens keep flowing through untouched.
    const { themeVariables } = useAuthUI();
    const themeStyle = Object.entries(themeVariables)
        .map(([property, value]) => `${property}:${value}`)
        .join(";");
</script>

<section class="lunora-auth-card" style={themeStyle}>
    <header class="lunora-auth-card__header">
        <h1 class="lunora-auth-card__title">{title}</h1>
        {#if description !== undefined}
            <p class="lunora-auth-card__description">{description}</p>
        {/if}
    </header>
    <div class="lunora-auth-card__body">{@render children()}</div>
    {#if footer !== undefined}
        <footer class="lunora-auth-card__footer">{@render footer()}</footer>
    {/if}
</section>
