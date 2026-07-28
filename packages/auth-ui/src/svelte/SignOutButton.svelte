<script lang="ts">
    import type { Snippet } from "svelte";

    import { signOut } from "../core/session-actions";
    import { useAuthUI } from "./context";

    let { children }: { children?: Snippet } = $props();

    const context = useAuthUI();
    // `null` rather than "" so an unthemed button renders no style attribute.
    const themeStyle =
        Object.keys(context.themeVariables).length === 0
            ? null
            : Object.entries(context.themeVariables)
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
