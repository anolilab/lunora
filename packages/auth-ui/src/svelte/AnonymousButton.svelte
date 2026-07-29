<!-- "Continue as guest", when the `anonymous` plugin is on. -->
<script lang="ts">
    import { signInAnonymously } from "../core/anonymous";
    import { useAuthUI } from "./context";

    const context = useAuthUI();
</script>

<button
    class="lunora-auth-button lunora-auth-button--secondary"
    onclick={() => {
        void signInAnonymously(context);
    }}
    type="button"
>
    {context.localization.anonymousSignIn}
</button>
