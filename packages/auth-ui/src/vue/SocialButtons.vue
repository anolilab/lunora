<script setup lang="ts">
// OAuth provider buttons. Rendered only when the caller passes providers —
// which, with server discovery on, is whatever `socialProviders` the deployment
// configured. Emits `select` with the chosen provider id.
//
// The provider's brand mark is left to CSS: each button carries a
// `lunora-auth-social__icon--<provider>` class, so an app drops in its own icon
// set with a stylesheet rule and this package ships no SVG payload for a list of
// providers it can't know in advance.
import { providerLabel } from "../core/labels";
import { useAuthUI } from "./provider";

defineProps<{
    /** Highlight the provider used last on this device, when known. */
    lastUsed?: string;
    providers: ReadonlyArray<string>;
}>();

const emit = defineEmits<{
    select: [provider: string];
}>();

const { localization: t } = useAuthUI();
</script>

<template>
    <div v-if="providers.length > 0" class="lunora-auth-social">
        <button
            v-for="provider in providers"
            :key="provider"
            class="lunora-auth-button lunora-auth-button--secondary lunora-auth-social__button"
            type="button"
            @click="emit('select', provider)"
        >
            <span aria-hidden="true" :class="`lunora-auth-social__icon lunora-auth-social__icon--${provider}`" />
            <span class="lunora-auth-social__label">{{ `${t.signInWith} ${providerLabel(provider)}` }}</span>
            <span v-if="lastUsed === provider" class="lunora-auth-social__badge">{{ t.lastUsed }}</span>
        </button>
    </div>
</template>
