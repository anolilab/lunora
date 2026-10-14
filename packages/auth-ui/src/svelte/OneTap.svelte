<!--
    Fires Google One Tap once on mount. Renders nothing — the prompt is Google's
    own floating UI, not ours.

    Mount it on the sign-in screen only when signed out; it is an accelerator
    beside the form, and every reason it declines to appear is normal (see
    `core/one-tap.ts`).
-->
<script lang="ts">
    import { promptOneTap } from "../core/one-tap";
    import { useAuthUI } from "./context";

    const context = useAuthUI();
    // Read once, so the effect below has no reactive dependency and fires exactly
    // once per mount: re-prompting on every context change would nag the user.
    const enabled = context.plugins.oneTap;

    $effect(() => {
        if (enabled) {
            void promptOneTap(context);
        }
    });
</script>
