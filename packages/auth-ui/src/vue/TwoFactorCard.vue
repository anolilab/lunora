<script setup lang="ts">
import { createTwoFactorVerifyController, isFlowEnabled } from "../core";
import AuthCard from "./AuthCard.vue";
import Field from "./Field.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUI } from "./provider";
import SubmitButton from "./SubmitButton.vue";
import { useController } from "./use-controller";

const props = defineProps<{
    method?: "otp" | "totp";
    trustDevice?: boolean;
}>();

const context = useAuthUI();
const t = context.localization;
const enabled = isFlowEnabled(context, "twoFactor", "TwoFactorCard");
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
