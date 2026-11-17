<script setup lang="ts">
// Primary submit button with a pending state and an optional resend cooldown.
import { ref, watchEffect } from "vue";

import { cooldownLabel, watchCooldown } from "../core/cooldown";
import { useAuthUI } from "./provider";

const props = defineProps<{
    /** A send/resend flow's `resendAvailableAt`: disabled, with a countdown, until then. */
    availableAt?: number;
    pending: boolean;
}>();

const { localization: t } = useAuthUI();
const wait = ref(0);

watchEffect((onCleanup) => {
    onCleanup(
        watchCooldown(props.availableAt, (seconds) => {
            wait.value = seconds;
        }),
    );
});
</script>

<template>
    <button class="lunora-auth-button" type="submit" :disabled="pending || wait > 0">
        <span v-if="pending" aria-hidden="true" class="lunora-auth-button__spinner" />
        <slot />
        <span v-if="wait > 0" class="lunora-auth-button__cooldown">{{ cooldownLabel(t, wait) }}</span>
    </button>
</template>
