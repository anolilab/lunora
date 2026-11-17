<!-- Primary submit button with a pending state and an optional resend cooldown. -->
<script lang="ts">
    import type { Snippet } from "svelte";

    import { cooldownLabel, watchCooldown } from "../core/cooldown";
    import { useAuthUI } from "./context";

    let {
        availableAt,
        children,
        pending,
    }: {
        /** A send/resend flow's `resendAvailableAt`: disabled, with a countdown, until then. */
        availableAt?: number;
        children: Snippet;
        pending: boolean;
    } = $props();

    const t = useAuthUI().localization;
    let wait = $state(0);

    $effect(() =>
        watchCooldown(availableAt, (seconds) => {
            wait = seconds;
        }),
    );
</script>

<button class="lunora-auth-button" disabled={pending || wait > 0} type="submit">
    {#if pending}
        <span aria-hidden="true" class="lunora-auth-button__spinner"></span>
    {/if}
    {@render children()}
    {#if wait > 0}
        <span class="lunora-auth-button__cooldown">{cooldownLabel(t, wait)}</span>
    {/if}
</button>
