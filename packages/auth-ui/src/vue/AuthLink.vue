<script setup lang="ts">
import { useAuthUILink } from "./provider";

// Internal link using the provider's framework `Link` component when present,
// else a plain `<a>`.
defineProps<{
    href: string;
}>();

const Link = useAuthUILink();
</script>

<template>
    <component :is="Link" v-if="Link" class="lunora-auth-link" :href="href">
        <slot />
    </component>
    <a v-else class="lunora-auth-link" :href="href">
        <slot />
    </a>
</template>
