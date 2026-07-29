<script setup lang="ts">
// Sign in with a phone number and password.
import { computed } from "vue";

import { isFlowEnabled } from "../core/flow-gate";
import { createPhoneSignInController } from "../core/phone-number";
import AuthCard from "./AuthCard.vue";
import Field from "./Field.vue";
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
            <Field
                :field="state.fields.phoneNumber"
                :label="t.phoneLabel"
                name="phoneNumber"
                autoComplete="tel"
                @blur="actions.blur('phoneNumber')"
                @change="actions.setField('phoneNumber', $event)"
            />
            <Field
                :field="state.fields.password"
                :label="t.passwordLabel"
                name="password"
                type="password"
                autoComplete="current-password"
                @blur="actions.blur('password')"
                @change="actions.setField('password', $event)"
            />
            <SubmitButton :pending="state.status === 'submitting'">{{ t.signIn }}</SubmitButton>
        </form>
    </AuthCard>
</template>
