<script setup lang="ts">
// Primary submit button with a pending state.
defineProps<{
    pending: boolean;
}>();
</script>

<template>
    <button class="lunora-auth-button" type="submit" :disabled="pending">
        <span v-if="pending" aria-hidden="true" class="lunora-auth-button__spinner" />
        <slot />
    </button>
</template>
