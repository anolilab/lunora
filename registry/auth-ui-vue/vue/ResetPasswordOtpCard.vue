<script setup lang="ts">
// Redeems an emailed one-time code instead of a link — for apps that set
// `forgotPassword: { method: "otp" }`. Unlike ResetPasswordCard, the email
// address is a field rather than something carried from the previous screen:
// a code can legitimately be redeemed from a fresh tab.
import { createResetPasswordOtpController } from "../core/reset-password-otp";
import AuthCard from "./AuthCard.vue";
import Field from "./Field.vue";
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
            <Field
                :field="state.fields.email"
                :label="t.emailLabel"
                name="email"
                type="email"
                autoComplete="email"
                @blur="actions.blur('email')"
                @change="actions.setField('email', $event)"
            />
            <Field
                :field="state.fields.otp"
                :label="t.codeLabel"
                name="otp"
                autoComplete="one-time-code"
                @blur="actions.blur('otp')"
                @change="actions.setField('otp', $event)"
            />
            <Field
                :field="state.fields.password"
                :label="t.passwordLabel"
                name="password"
                type="password"
                autoComplete="new-password"
                @blur="actions.blur('password')"
                @change="actions.setField('password', $event)"
            />
            <Field
                :field="state.fields.confirmPassword"
                :label="t.confirmPasswordLabel"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                @blur="actions.blur('confirmPassword')"
                @change="actions.setField('confirmPassword', $event)"
            />
            <SubmitButton :pending="state.status === 'submitting'">{{ t.resetPassword }}</SubmitButton>
        </form>
    </AuthCard>
</template>
