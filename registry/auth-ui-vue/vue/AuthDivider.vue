<script setup lang="ts">
// A labelled visual separator ("or").
withDefaults(
    defineProps<{
        label?: string;
    }>(),
    {
        label: "or",
    },
);
</script>

<template>
    <div class="lunora-auth-divider" role="separator">
        <span class="lunora-auth-divider__label">{{ label }}</span>
    </div>
</template>
