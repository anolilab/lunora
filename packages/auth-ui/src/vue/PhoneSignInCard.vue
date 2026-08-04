<script setup lang="ts">
// Sign in with a phone number and password.
import { computed } from "vue";

import { isFlowEnabled } from "../core/flow-gate";
import { createPhoneSignInController } from "../core/phone-number";
import AuthCard from "./AuthCard.vue";
import FormField from "./FormField.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUIContextRef } from "./provider";
import SubmitButton from "./SubmitButton.vue";
import { useController } from "./use-controller";

const context = useAuthUIContextRef();
const t = context.value.localization;
// Computed, not read at setup: `setup()` never re-runs, so a gate resolved here
// would stay frozen on the pre-discovery answer. See `provider.ts`.
const enabled = computed(() => isFlowEnabled(context.value, "phoneNumber", "PhoneSignInCard"));
const { actions, state } = useController(createPhoneSignInController);
</script>

<template>
    <AuthCard v-if="enabled" :title="t.signIn">
        <form class="lunora-auth-form" novalidate @submit.prevent="actions.submit">
            <FormBanner :error="state.formError" />
            <FormField :actions="actions" field="phoneNumber" :fields="state.fields" :label="t.phoneLabel" autoComplete="tel" />
            <FormField :actions="actions" field="password" :fields="state.fields" :label="t.passwordLabel" type="password" autoComplete="current-password" />
            <SubmitButton :pending="state.status === 'submitting'">{{ t.signIn }}</SubmitButton>
        </form>
    </AuthCard>
</template>
