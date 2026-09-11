<script lang="ts">
    import type { Snippet } from "svelte";

    /**
     * The card chrome, matching `react/primitives.tsx` element for element and
     * class for class. Both ports render the same DOM so one stylesheet serves
     * them — that is what `styles.css` being a single shared file requires.
     */
    interface Props {
        actions?: Snippet;
        children: Snippet;
        subtitle?: string;
        title: string;
    }

    const { actions, children, subtitle, title }: Props = $props();
</script>

<section class="lu-saas-card">
    <header class="lu-saas-card__head">
        <div>
            <h2 class="lu-saas-card__title">{title}</h2>
            {#if subtitle}<p class="lu-saas-card__subtitle">{subtitle}</p>{/if}
        </div>
        {#if actions}<div class="lu-saas-card__actions">{@render actions()}</div>{/if}
    </header>
    {@render children()}
</section>
