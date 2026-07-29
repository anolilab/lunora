<script setup lang="ts">
// A user's photo, or their initials when there isn't one.
//
// The image is the only thing here that can fail at runtime, so a broken URL
// falls back to the initials rather than to a browser's broken-image glyph —
// `user.image` is a plain string column an app can put anything in.
import { computed, ref, watch } from "vue";

import type { AuthUser } from "../core/types";
import { userInitials } from "../core/session";

const props = withDefaults(
    defineProps<{
        size?: number;
        user?: AuthUser;
    }>(),
    {
        size: 32,
    },
);

const failed = ref(false);

// A new user means a new image URL, so a previous failure must not stick to it.
watch(
    () => props.user?.image,
    () => {
        failed.value = false;
    },
);

const style = computed(() => {
    return { height: `${props.size}px`, width: `${props.size}px` };
});

const showImage = computed(() => {
    const image = props.user?.image;

    return image !== undefined && image !== "" && !failed.value;
});
</script>

<template>
    <img v-if="showImage" alt="" class="lunora-auth-avatar" :src="user?.image" :style="style" @error="failed = true" />
    <span v-else aria-hidden="true" class="lunora-auth-avatar lunora-auth-avatar--initials" :style="style">{{ userInitials(user) }}</span>
</template>
