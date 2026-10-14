<script setup lang="ts">
// A labelled visual separator ("or"). The label is repeated as `aria-label`
// because a `separator` role makes its children presentational — the visible
// "or" is dropped from the accessibility tree, and naming the separator is the
// only way to get it back.
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
    <div class="lunora-auth-divider" role="separator" :aria-label="label">
        <span class="lunora-auth-divider__label">{{ label }}</span>
    </div>
</template>
