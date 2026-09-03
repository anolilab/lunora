<script setup lang="ts">
import { computed } from "vue";

import { isFlowEnabled } from "../core/flow-gate";
import { LAST_METHOD_MAGIC_LINK, readLastLoginMethod } from "../core/last-login-method";
import { createMagicLinkController } from "../core/magic-link";
import AuthCard from "./AuthCard.vue";
import AuthLink from "./AuthLink.vue";
import FormField from "./FormField.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUIContextRef } from "./provider";
import SubmitButton from "./SubmitButton.vue";
import { useController } from "./use-controller";

withDefaults(
    defineProps<{
        signInHref?: string;
    }>(),
    {
        signInHref: "/sign-in",
    },
);

const context = useAuthUIContextRef();
const t = context.value.localization;
// Computed, not read at setup: `setup()` never re-runs, so a gate resolved here
// would stay frozen on the pre-discovery answer. See `provider.ts`.
const enabled = computed(() => isFlowEnabled(context.value, "magicLink", "MagicLinkCard"));
const { actions, state } = useController(createMagicLinkController);
// Read once at setup rather than from a watcher: it is a cookie, it is there
// before the first paint, and it only picks a badge.
const lastUsed = readLastLoginMethod();
</script>

<template>
    <AuthCard v-if="enabled" :title="t.magicLink">
        <form class="lunora-auth-form" novalidate @submit.prevent="actions.submit">
            <FormBanner :error="state.formError" :success="state.successMessage" />
            <FormField :actions="actions" field="email" :fields="state.fields" :label="t.emailLabel" type="email" autoComplete="email" />
            <SubmitButton :pending="state.status === 'submitting'">
                {{ t.magicLink }}
                <span v-if="lastUsed === LAST_METHOD_MAGIC_LINK" class="lunora-auth-social__badge">{{ t.lastUsed }}</span>
            </SubmitButton>
        </form>
        <template #footer>
            <AuthLink :href="signInHref">{{ t.backToSignIn }}</AuthLink>
        </template>
    </AuthCard>
</template>
