<script setup lang="ts">
import { createEmailOtpController, isFlowEnabled } from "../core";
import AuthCard from "./AuthCard.vue";
import Field from "./Field.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUI } from "./provider";
import SubmitButton from "./SubmitButton.vue";
import { useController } from "./use-controller";

const context = useAuthUI();
const t = context.localization;
const enabled = isFlowEnabled(context, "emailOtp", "EmailOtpCard");
const { actions, state } = useController(createEmailOtpController);
</script>

<template>
    <AuthCard v-if="enabled && state.step === 'verify'" :title="t.emailOtp" :description="t.emailOtpSent">
        <form class="lunora-auth-form" novalidate @submit.prevent="actions.verify">
            <FormBanner :error="state.formError" />
            <Field :field="state.code" :label="t.codeLabel" name="code" autoComplete="one-time-code" @change="actions.setCode" />
            <SubmitButton :pending="state.status === 'submitting'">{{ t.twoFactor }}</SubmitButton>
        </form>
        <template #footer>
            <button class="lunora-auth-link" type="button" @click="actions.back">{{ t.sendNewCode }}</button>
        </template>
    </AuthCard>
    <AuthCard v-else-if="enabled" :title="t.emailOtp">
        <form class="lunora-auth-form" novalidate @submit.prevent="actions.sendCode">
            <FormBanner :error="state.formError" :success="state.successMessage" />
            <Field :field="state.email" :label="t.emailLabel" name="email" type="email" autoComplete="email" @change="actions.setEmail" />
            <SubmitButton :pending="state.status === 'submitting'">{{ t.emailOtp }}</SubmitButton>
        </form>
    </AuthCard>
</template>
