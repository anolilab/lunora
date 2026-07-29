<script setup lang="ts">
// Whether a username is free, shown as the user types.
//
// Advisory only — the check races the submit and the server stays the
// authority — so a failed check ("unknown") reads as nothing rather than as a
// rejection.
import { computed } from "vue";

import type { AvailabilityStatus } from "../core/username-availability";
import { useAuthUI } from "./provider";

const props = defineProps<{
    status: AvailabilityStatus;
}>();

// A plain read: localization is not something server discovery can change.
const t = useAuthUI().localization;
// Computed, not read in `setup()`: the status changes under a mounted component.
const message = computed(() => {
    if (props.status === "checking") {
        return t.usernameChecking;
    }

    return props.status === "taken" ? t.usernameTaken : t.usernameAvailable;
});
</script>

<template>
    <p v-if="status !== 'idle' && status !== 'unknown'" :class="`lunora-auth-availability lunora-auth-availability--${status}`" role="status">
        {{ message }}
    </p>
</template>
