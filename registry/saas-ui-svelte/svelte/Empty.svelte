<script lang="ts">
    import type { Snippet } from "svelte";

    interface Props {
        children?: Snippet;
        title: string;
    }

    const { children, title }: Props = $props();
</script>

<div class="lu-saas-empty">
    <p class="lu-saas-empty__title">{title}</p>
    {#if children}<div class="lu-saas-empty__body">{@render children()}</div>{/if}
</div>
