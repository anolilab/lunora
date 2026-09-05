<script setup lang="ts">
// "Continue as guest", when the `anonymous` plugin is on. The in-flight state
// (and the double-click guard behind it) belongs to `createAnonymousController`.
import { createAnonymousController } from "../core/anonymous";
import { useAuthUI } from "./provider";
import { useController } from "./use-controller";

const context = useAuthUI();
const { actions, state } = useController(createAnonymousController);

const onSignIn = (): void => {
    void actions.signIn();
};
</script>

<template>
    <button class="lunora-auth-button lunora-auth-button--secondary" type="button" :disabled="state.status === 'submitting'" @click="onSignIn">
        {{ context.localization.anonymousSignIn }}
    </button>
</template>
