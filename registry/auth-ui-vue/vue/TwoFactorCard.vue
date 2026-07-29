<script setup lang="ts">
import { computed } from "vue";

import { isFlowEnabled } from "../core/flow-gate";
import { createTwoFactorVerifyController } from "../core/two-factor-verify";
import AuthCard from "./AuthCard.vue";
import Field from "./Field.vue";
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
</script>

<template>
    <AuthCard v-if="enabled" :title="t.twoFactor">
        <form class="lunora-auth-form" novalidate @submit.prevent="actions.submit">
            <FormBanner :error="state.formError" />
            <Field
                :field="state.fields.code"
                :label="t.codeLabel"
                name="code"
                autoComplete="one-time-code"
                @blur="actions.blur('code')"
                @change="actions.setField('code', $event)"
            />
            <SubmitButton :pending="state.status === 'submitting'">{{ t.twoFactor }}</SubmitButton>
        </form>
    </AuthCard>
</template>
