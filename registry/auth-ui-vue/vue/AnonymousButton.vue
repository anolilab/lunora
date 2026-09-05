<script setup lang="ts">
// "Continue as guest", when the `anonymous` plugin is on.
//
// Disabled while the call is in flight: `signIn.anonymous` creates an account
// every time it is called, so a double-click without this leaves a second,
// orphaned anonymous user behind — and the first click gives no feedback that
// anything happened, which is what invites the second.
import { ref } from "vue";
import { signInAnonymously } from "../core/anonymous";
import { useAuthUI } from "./provider";

const context = useAuthUI();
const pending = ref(false);

const onSignIn = (): void => {
    pending.value = true;
    void signInAnonymously(context).finally(() => {
        pending.value = false;
    });
};
</script>

<template>
    <button class="lunora-auth-button lunora-auth-button--secondary" type="button" :disabled="pending" @click="onSignIn">
        {{ context.localization.anonymousSignIn }}
    </button>
</template>
