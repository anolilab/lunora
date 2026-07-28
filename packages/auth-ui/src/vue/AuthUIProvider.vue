<script setup lang="ts">
import type { AuthUIProviderProps } from "./provider";
import { provideAuthUI } from "./provider";

// Provides the resolved auth-UI context to the default slot. One base component
// set serves every meta-framework: pass your router into `nav`/`Link` (Nuxt,
// vue-router, Astro islands) and the cards navigate through it.
const props = defineProps<AuthUIProviderProps>();

provideAuthUI(props);
</script>

<template>
    <slot />
</template>
