<script setup lang="ts">
// Card shell: heading, optional description, body (default slot), optional
// footer (named `footer` slot).
import { computed } from "vue";

import { useAuthUI } from "./provider";

const props = withDefaults(
    defineProps<{
        description?: string;
        /**
         * The title's heading level (default 1) — see the React `AuthCard`'s
         * doc comment for why a settings/organization composition passes `2`
         * rather than letting every card render an `h1`.
         */
        headingLevel?: 1 | 2 | 3;
        title: string;
    }>(),
    { headingLevel: 1 },
);

const headingTag = computed(() => `h${props.headingLevel}` as const);

// Only set when the app configured `theme` — otherwise the app's own design
// tokens keep flowing through untouched.
const { themeVariables } = useAuthUI();
const themeStyle = Object.keys(themeVariables).length === 0 ? undefined : themeVariables;
</script>

<template>
    <section class="lunora-auth-card" :style="themeStyle">
        <header class="lunora-auth-card__header">
            <component :is="headingTag" class="lunora-auth-card__title">{{ title }}</component>
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
