<!--
    "Continue as guest", when the `anonymous` plugin is on. The in-flight state
    (and the double-click guard behind it) belongs to `createAnonymousController`.
-->
<script lang="ts">
    import { createAnonymousController } from "../core/anonymous";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";

    const context = useAuthUI();
    // `state` is renamed: `$state` is a rune, not a store read.
    const { actions, state: flow } = controllerStore(createAnonymousController);
</script>

<button
    class="lunora-auth-button lunora-auth-button--secondary"
    disabled={$flow.status === "submitting"}
    onclick={() => {
        void actions.signIn();
    }}
    type="button"
>
    {context.localization.anonymousSignIn}
</button>
