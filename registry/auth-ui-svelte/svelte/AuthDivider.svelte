<!--
    A labelled visual separator ("or"). The label is repeated as `aria-label`
    because a `separator` role makes its children presentational — the visible
    "or" is dropped from the accessibility tree, and naming the separator is the
    only way to get it back.
-->
<script lang="ts">
    let { label = "or" }: { label?: string } = $props();
</script>

<div aria-label={label} class="lunora-auth-divider" role="separator">
    <span class="lunora-auth-divider__label">{label}</span>
</div>
