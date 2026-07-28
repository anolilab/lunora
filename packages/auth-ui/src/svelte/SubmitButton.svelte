<!-- Primary submit button with a pending state. -->
<script lang="ts">
    import type { Snippet } from "svelte";

    let {
        children,
        pending,
    }: {
        children: Snippet;
        pending: boolean;
    } = $props();
</script>

<button class="lunora-auth-button" disabled={pending} type="submit">
    {#if pending}
        <span aria-hidden="true" class="lunora-auth-button__spinner"></span>
    {/if}
    {@render children()}
</button>
