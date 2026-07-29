<!--
    A loading placeholder sized in rows. Purely decorative, and hidden from the
    accessibility tree: the region it fills is already announced as busy by the
    card that owns it, and a screen reader has no use for "three grey boxes".
-->
<script lang="ts">
    let { rows = 3 }: { rows?: number } = $props();

    // Placeholders have no identity, so the index *is* the key: the array is
    // fixed-length and never reordered.
    const indexes = $derived(Array.from({ length: rows }, (_, index) => index));
</script>

<div aria-hidden="true" class="lunora-auth-skeleton">
    {#each indexes as index (index)}
        <span class="lunora-auth-skeleton__row"></span>
    {/each}
</div>
