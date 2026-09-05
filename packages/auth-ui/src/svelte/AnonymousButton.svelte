<!--
    "Continue as guest", when the `anonymous` plugin is on.

    Disabled while the call is in flight: `signIn.anonymous` creates an account
    every time it is called, so a double-click without this leaves a second,
    orphaned anonymous user behind — and the first click gives no feedback that
    anything happened, which is what invites the second.
-->
<script lang="ts">
    import { signInAnonymously } from "../core/anonymous";
    import { useAuthUI } from "./context";

    const context = useAuthUI();
    let pending = $state(false);
</script>

<button
    class="lunora-auth-button lunora-auth-button--secondary"
    disabled={pending}
    onclick={() => {
        pending = true;
        void signInAnonymously(context).finally(() => {
            pending = false;
        });
    }}
    type="button"
>
    {context.localization.anonymousSignIn}
</button>
