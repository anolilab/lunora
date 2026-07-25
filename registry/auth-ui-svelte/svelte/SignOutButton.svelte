<script lang="ts">
    import type { Snippet } from "svelte";

    import { signOut } from "../core";
    import { useAuthUI } from "./context";

    let { children }: { children?: Snippet } = $props();

    const context = useAuthUI();
    const themeStyle = Object.entries(context.themeVariables)
        .map(([property, value]) => `${property}:${value}`)
        .join(";");
</script>

<button
    class="lunora-auth-button lunora-auth-button--secondary"
    onclick={() => {
        void signOut(context);
    }}
    style={themeStyle}
    type="button"
>
    {#if children}{@render children()}{:else}{context.localization.signOut}{/if}
</button>
