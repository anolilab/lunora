<script setup lang="ts">
import { computed, ref } from "vue";

import { createBackupCodeSignInController } from "../core/backup-codes";
import { isFlowEnabled } from "../core/flow-gate";
import { createTwoFactorVerifyController } from "../core/two-factor-verify";
import AuthCard from "./AuthCard.vue";
import FormField from "./FormField.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUIContextRef } from "./provider";
import SubmitButton from "./SubmitButton.vue";
import { useController } from "./use-controller";

const props = defineProps<{
    method?: "otp" | "totp";
    trustDevice?: boolean;
}>();

const context = useAuthUIContextRef();
const t = context.value.localization;
// Computed, not read at setup: `setup()` never re-runs, so a gate resolved here
// would stay frozen on the pre-discovery answer. See `provider.ts`.
const enabled = computed(() => isFlowEnabled(context.value, "twoFactor", "TwoFactorCard"));
const { actions, state } = useController((context_) => createTwoFactorVerifyController(context_, { method: props.method, trustDevice: props.trustDevice }));
// Both controllers stay live regardless of which form is showing — a
// session-mutating submit must not depend on the toggle's current position.
const { actions: backupActions, state: backupState } = useController((context_) =>
    createBackupCodeSignInController(context_, { trustDevice: props.trustDevice }),
);
const useBackupCode = ref(false);
</script>

<template>
    <AuthCard v-if="enabled && useBackupCode" :title="t.twoFactor">
        <form class="lunora-auth-form" novalidate @submit.prevent="backupActions.submit">
            <FormBanner :error="backupState.formError" />
            <FormField :actions="backupActions" field="code" :fields="backupState.fields" :label="t.backupCodeLabel" autoComplete="one-time-code" />
            <SubmitButton :pending="backupState.status === 'submitting'">{{ t.twoFactor }}</SubmitButton>
        </form>
        <template #footer>
            <button class="lunora-auth-link" type="button" @click="useBackupCode = false">{{ t.twoFactorUseAuthenticator }}</button>
        </template>
    </AuthCard>
    <AuthCard v-else-if="enabled" :title="t.twoFactor">
        <form class="lunora-auth-form" novalidate @submit.prevent="actions.submit">
            <FormBanner :error="state.formError" />
            <FormField :actions="actions" field="code" :fields="state.fields" :label="t.codeLabel" autoComplete="one-time-code" />
            <SubmitButton :pending="state.status === 'submitting'">{{ t.twoFactor }}</SubmitButton>
        </form>
        <template #footer>
            <button class="lunora-auth-link" type="button" @click="useBackupCode = true">{{ t.backupCodeSignIn }}</button>
        </template>
    </AuthCard>
</template>
