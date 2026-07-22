<script setup lang="ts">
// Card shell: heading, optional description, body (default slot), optional
// footer (named `footer` slot).
defineProps<{
    description?: string;
    title: string;
}>();
</script>

<template>
    <section class="lunora-auth-card">
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
