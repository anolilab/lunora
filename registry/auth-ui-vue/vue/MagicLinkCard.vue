<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { viewHref } from "../core/config";
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

const props = defineProps<{
    /** Defaults to the configured sign-in route; see `viewPaths.base`. */
    signInHref?: string;
}>();

const context = useAuthUIContextRef();
const t = context.value.localization;
// Computed, not read at setup: `setup()` never re-runs, so a gate resolved here
// would stay frozen on the pre-discovery answer. See `provider.ts`.
const enabled = computed(() => isFlowEnabled(context.value, "magicLink", "MagicLinkCard"));
const signInLink = computed(() => props.signInHref ?? viewHref(context.value, "signIn"));
const { actions, state } = useController(createMagicLinkController);
// Read after mount, not at setup: the server has no cookie, so a render-time
// read is a hydration mismatch. See `lastLoginMethodStore`.
const lastUsedAfterMount = ref<string | undefined>();

onMounted(() => {
    lastUsedAfterMount.value = readLastLoginMethod();
});

const lastUsed = computed(() => (context.value.plugins.lastLoginMethod ? lastUsedAfterMount.value : undefined));
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
            <AuthLink :href="signInLink">{{ t.backToSignIn }}</AuthLink>
        </template>
    </AuthCard>
</template>
