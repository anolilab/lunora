<!-- Top-level error / success banner (error is announced via role="alert"). -->
<script lang="ts">
    let {
        error,
        success,
    }: {
        error?: string;
        success?: string;
    } = $props();
</script>

{#if error !== undefined}
    <p class="lunora-auth-banner lunora-auth-banner--error" role="alert">{error}</p>
{:else if success !== undefined}
    <p class="lunora-auth-banner lunora-auth-banner--success" role="status">{success}</p>
{/if}
