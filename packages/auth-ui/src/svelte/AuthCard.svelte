<!-- Card shell: heading, optional description, body, and optional footer. -->
<script lang="ts">
    import type { Snippet } from "svelte";

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
</script>

<section class="lunora-auth-card">
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
