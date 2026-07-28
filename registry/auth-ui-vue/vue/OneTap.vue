<script setup lang="ts">
// Fires Google One Tap once on mount. Renders nothing — the prompt is Google's
// own floating UI, not ours.
//
// Mount it on the sign-in screen only when signed out; it is an accelerator
// beside the form, and every reason it declines to appear is normal (see
// `core/one-tap.ts`).
import { onMounted } from "vue";

import { promptOneTap } from "../core/one-tap";
import { useAuthUI } from "./provider";

const context = useAuthUI();

// Once per mount: `setup()` never re-runs in Vue, which is exactly the
// fire-once behaviour React has to ask for with an empty dependency list —
// re-prompting on every context change would nag the user.
onMounted(() => {
    if (context.plugins.oneTap) {
        void promptOneTap(context);
    }
});
</script>

<template>
    <!-- Deliberately empty: Google owns the prompt's UI. -->
</template>
