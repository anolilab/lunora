<script setup lang="ts">
// Top-level error / success banner. Error is announced via `role="alert"`,
// success via `role="status"`. Error takes precedence when both are set.
defineProps<{
    error?: string;
    success?: string;
}>();
</script>

<template>
    <p v-if="error !== undefined" class="lunora-auth-banner lunora-auth-banner--error" role="alert">{{ error }}</p>
    <p v-else-if="success !== undefined" class="lunora-auth-banner lunora-auth-banner--success" role="status">{{ success }}</p>
</template>
