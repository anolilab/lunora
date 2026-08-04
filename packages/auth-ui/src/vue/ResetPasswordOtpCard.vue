<script setup lang="ts">
// Redeems an emailed one-time code instead of a link — for apps that set
// `forgotPassword: { method: "otp" }`. Unlike ResetPasswordCard, the email
// address is a field rather than something carried from the previous screen:
// a code can legitimately be redeemed from a fresh tab.
import { createResetPasswordOtpController } from "../core/reset-password-otp";
import AuthCard from "./AuthCard.vue";
import FormField from "./FormField.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUI } from "./provider";
import SubmitButton from "./SubmitButton.vue";
import { useController } from "./use-controller";

const { localization: t } = useAuthUI();
const { actions, state } = useController((context) => createResetPasswordOtpController(context));
</script>

<template>
    <AuthCard :description="t.resetPasswordOtpDescription" :title="t.resetPassword">
        <form class="lunora-auth-form" novalidate @submit.prevent="actions.submit">
            <FormBanner :error="state.formError" :success="state.successMessage" />
            <FormField :actions="actions" field="email" :fields="state.fields" :label="t.emailLabel" type="email" autoComplete="email" />
            <FormField :actions="actions" field="otp" :fields="state.fields" :label="t.codeLabel" autoComplete="one-time-code" />
            <FormField :actions="actions" field="password" :fields="state.fields" :label="t.passwordLabel" type="password" autoComplete="new-password" />
            <FormField
                :actions="actions"
                field="confirmPassword"
                :fields="state.fields"
                :label="t.confirmPasswordLabel"
                type="password"
                autoComplete="new-password"
            />
            <SubmitButton :pending="state.status === 'submitting'">{{ t.resetPassword }}</SubmitButton>
        </form>
    </AuthCard>
</template>
