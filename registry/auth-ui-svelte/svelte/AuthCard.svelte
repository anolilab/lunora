<!-- Card shell: heading, optional description, body, and optional footer. -->
<script lang="ts">
    import type { Snippet } from "svelte";

    import { useAuthUI } from "./context";

    let {
        children,
        description,
        footer,
        headingLevel = 1,
        title,
    }: {
        children: Snippet;
        description?: string;
        footer?: Snippet;
        /**
         * The title's heading level (default 1) — see the React `AuthCard`'s
         * doc comment for why a settings/organization composition passes `2`
         * rather than letting every card render an `h1`.
         */
        headingLevel?: 1 | 2 | 3;
        title: string;
    } = $props();

    const HeadingTag = $derived(`h${headingLevel}` as const);

    // Only set when the app configured `theme` — otherwise the app's own design
    // tokens keep flowing through untouched.
    const { themeVariables } = useAuthUI();
    // `null` rather than "" so an unthemed card renders no style attribute at
    // all, matching the other four ports.
    const themeStyle =
        Object.keys(themeVariables).length === 0
            ? null
            : Object.entries(themeVariables)
                  .map(([property, value]) => `${property}:${value}`)
                  .join(";");
</script>

<section class="lunora-auth-card" style={themeStyle}>
    <header class="lunora-auth-card__header">
        <svelte:element this={HeadingTag} class="lunora-auth-card__title">{title}</svelte:element>
        {#if description !== undefined}
            <p class="lunora-auth-card__description">{description}</p>
        {/if}
    </header>
    <div class="lunora-auth-card__body">{@render children()}</div>
    {#if footer !== undefined}
        <footer class="lunora-auth-card__footer">{@render footer()}</footer>
    {/if}
</section>
