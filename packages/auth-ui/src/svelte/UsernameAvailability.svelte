<!--
    Whether a username is free, shown as the user types.

    Advisory only — the check races the submit and the server stays the
    authority — so a failed check ("unknown") reads as nothing rather than as a
    rejection.
-->
<script lang="ts">
    import type { AvailabilityStatus } from "../core/username-availability";
    import { useAuthUI } from "./context";

    let { status }: { status: AvailabilityStatus } = $props();

    const t = useAuthUI().localization;
    // `$derived`: the status changes under a mounted component.
    const message = $derived(status === "checking" ? t.usernameChecking : status === "taken" ? t.usernameTaken : t.usernameAvailable);
</script>

{#if status !== "idle" && status !== "unknown"}
    <p class="lunora-auth-availability lunora-auth-availability--{status}" role="status">{message}</p>
{/if}
