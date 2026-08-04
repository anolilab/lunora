<script setup lang="ts">
// "Send me another link" — the companion to <VerifyEmailCard>.
import { createResendVerificationController } from "../core/verify-email";
import AuthCard from "./AuthCard.vue";
import FormField from "./FormField.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUI } from "./provider";
import SubmitButton from "./SubmitButton.vue";
import { useController } from "./use-controller";

const { localization: t } = useAuthUI();
const { actions, state } = useController(createResendVerificationController);
</script>

<template>
    <AuthCard :title="t.verifyEmail">
        <form class="lunora-auth-form" novalidate @submit.prevent="actions.submit">
            <FormBanner :error="state.formError" :success="state.successMessage" />
            <FormField :actions="actions" field="email" :fields="state.fields" :label="t.emailLabel" type="email" autoComplete="email" />
            <SubmitButton :pending="state.status === 'submitting'">{{ t.verifyEmailResend }}</SubmitButton>
        </form>
    </AuthCard>
</template>
