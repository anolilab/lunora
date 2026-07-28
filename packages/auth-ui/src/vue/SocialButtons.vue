<script setup lang="ts">
// OAuth provider buttons. Rendered only when the caller passes providers.
// Emits `select` with the chosen provider id.
defineProps<{
    providers: ReadonlyArray<string>;
}>();

const emit = defineEmits<{
    select: [provider: string];
}>();

const labelFor = (provider: string): string => provider.charAt(0).toUpperCase() + provider.slice(1);
</script>

<template>
    <div v-if="providers.length > 0" class="lunora-auth-social">
        <button
            v-for="provider in providers"
            :key="provider"
            class="lunora-auth-button lunora-auth-button--secondary"
            type="button"
            @click="emit('select', provider)"
        >
            Continue with {{ labelFor(provider) }}
        </button>
    </div>
</template>
