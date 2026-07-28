<script setup lang="ts">
// Card shell: heading, optional description, body (default slot), optional
// footer (named `footer` slot).
import { useAuthUI } from "./provider";

defineProps<{
    description?: string;
    title: string;
}>();

// Only set when the app configured `theme` — otherwise the app's own design
// tokens keep flowing through untouched.
const { themeVariables } = useAuthUI();
const themeStyle = Object.keys(themeVariables).length === 0 ? undefined : themeVariables;
</script>

<template>
    <section class="lunora-auth-card" :style="themeStyle">
        <header class="lunora-auth-card__header">
            <h1 class="lunora-auth-card__title">{{ title }}</h1>
            <p v-if="description !== undefined" class="lunora-auth-card__description">{{ description }}</p>
        </header>
        <div class="lunora-auth-card__body">
            <slot />
        </div>
        <footer v-if="$slots.footer" class="lunora-auth-card__footer">
            <slot name="footer" />
        </footer>
    </section>
</template>
