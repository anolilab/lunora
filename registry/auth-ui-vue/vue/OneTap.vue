<script setup lang="ts">
// Fires Google One Tap once on mount. Renders nothing — the prompt is Google's
// own floating UI, not ours.
//
// Mount it on the sign-in screen only when signed out; it is an accelerator
// beside the form, and every reason it declines to appear is normal (see
// `core/one-tap.ts`).
import { computed, onMounted, watch } from "vue";

import { promptOneTap } from "../core/one-tap";
import { useAuthUIContextRef } from "./provider";

const context = useAuthUIContextRef();
const enabled = computed(() => context.value.plugins.oneTap);

let prompted = false;

const prompt = (): void => {
    if (prompted || !enabled.value) {
        return;
    }

    prompted = true;
    void promptOneTap(context.value);
};

// On mount rather than during `setup()`: the prompt is a browser handshake, and
// an SSR pass must not fire it.
onMounted(prompt);
/*
 * And once more if discovery is what turns the flow on — the same re-decision
 * React gets from `[enabled]`. `prompted` caps it at one prompt per mount either
 * way; re-prompting on every context change would nag the user.
 */
watch(enabled, prompt);
</script>

<!-- Renders nothing on purpose: Google owns the prompt's UI. A comment-only
     template is not a valid Vue root, so this is an explicit empty fragment. -->
<template><span v-if="false" /></template>
