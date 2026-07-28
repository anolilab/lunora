<script setup lang="ts">
// "Continue as guest", when the `anonymous` plugin is on.
import { signInAnonymously } from "../core/anonymous";
import { useAuthUI } from "./provider";

const context = useAuthUI();

const onSignIn = (): void => {
    void signInAnonymously(context);
};
</script>

<template>
    <button class="lunora-auth-button lunora-auth-button--secondary" type="button" @click="onSignIn">
        {{ context.localization.anonymousSignIn }}
    </button>
</template>
