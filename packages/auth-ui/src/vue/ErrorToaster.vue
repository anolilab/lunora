<script setup lang="ts">
// The errors that have no card to land in — a failed social redirect, a failed
// unlink, a sign-out that didn't. Mount it once in your app shell.
//
// Errors that *do* belong to a card still render on that card's banner and never
// reach here, so nothing is announced twice.
import { onScopeDispose, shallowRef } from "vue";

import { dismissToast, getToasts, subscribeToasts } from "../core/toast";

// The store is module-level (see `core/toast.ts`), so this is the same
// subscribe-and-copy shape `useController` uses — shallow because the list is
// replaced wholesale on every push, never mutated in place.
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
    <!-- `polite`, not `assertive`: these are failures the user can retry, not
    something that should interrupt a screen reader mid-sentence. -->
    <div v-if="toasts.length > 0" class="lunora-auth-toaster" aria-live="polite">
        <div v-for="toast in toasts" :key="toast.id" class="lunora-auth-toast" role="status">
            <span class="lunora-auth-toast__message">{{ toast.message }}</span>
            <button class="lunora-auth-toast__dismiss" type="button" aria-label="Dismiss" @click="onDismiss(toast.id)">×</button>
        </div>
    </div>
</template>
