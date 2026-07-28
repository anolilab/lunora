<!-- A labelled visual separator ("or"). -->
<script lang="ts">
    let { label = "or" }: { label?: string } = $props();
</script>

<div class="lunora-auth-divider" role="separator">
    <span class="lunora-auth-divider__label">{label}</span>
</div>
