<script setup lang="ts">
import { createTwoFactorVerifyController } from "../core";
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

const { localization: t } = useAuthUI();
const { actions, state } = useController((context) => createTwoFactorVerifyController(context, { method: props.method, trustDevice: props.trustDevice }));
</script>

<template>
    <AuthCard :title="t.twoFactor">
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
