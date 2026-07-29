<script setup lang="ts">
// A loading placeholder sized in rows. Purely decorative, and hidden from the
// accessibility tree: the region it fills is already announced as busy by the
// card that owns it, and a screen reader has no use for "three grey boxes".
withDefaults(
    defineProps<{
        rows?: number;
    }>(),
    {
        rows: 3,
    },
);
</script>

<template>
    <div aria-hidden="true" class="lunora-auth-skeleton">
        <span v-for="row in rows" :key="row" class="lunora-auth-skeleton__row" />
    </div>
</template>
