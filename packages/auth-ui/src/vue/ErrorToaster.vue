<script setup lang="ts">
// The errors that have no card to land in — a failed social redirect, a failed
// unlink, a sign-out that didn't. Mount it once in your app shell.
//
// Errors that *do* belong to a card still render on that card's banner and never
// reach here, so nothing is announced twice.
import { onScopeDispose, shallowRef } from "vue";

import { DEFAULT_LOCALIZATION } from "../core/localization";
import { dismissToast, getToasts, subscribeToasts } from "../core/toast";

// The store is module-level (see `core/toast.ts`), so this is the same
// subscribe-and-copy shape `useController` uses — shallow because the list is
// replaced wholesale on every push, never mutated in place.
// The dismiss button's accessible name is a prop rather than a read of the
// provider's `localization`, because the toaster is mounted in the app shell and
// must keep working outside `<AuthUIProvider>`.
withDefaults(defineProps<{ dismissLabel?: string }>(), { dismissLabel: DEFAULT_LOCALIZATION.dismiss });

const toasts = shallowRef(getToasts());

const unsubscribe = subscribeToasts(() => {
    toasts.value = getToasts();
});

onScopeDispose(unsubscribe);

const onDismiss = (id: number): void => {
    dismissToast(id);
};
</script>

<template>
    <!--
        `polite`, not `assertive`: these are failures the user can retry, not
        something that should interrupt a screen reader mid-sentence.

        Mounted unconditionally — including with no toasts yet. A live region
        only announces changes made AFTER it exists in the accessibility tree;
        gating the whole `<div>` on `toasts.length > 0` meant the very first
        toast landed before assistive tech was watching the region, so it went
        unannounced.
    -->
    <div class="lunora-auth-toaster" aria-live="polite">
        <div v-for="toast in toasts" :key="toast.id" class="lunora-auth-toast" role="status">
            <span class="lunora-auth-toast__message">{{ toast.message }}</span>
            <button class="lunora-auth-toast__dismiss" type="button" :aria-label="dismissLabel" @click="onDismiss(toast.id)">×</button>
        </div>
    </div>
</template>
