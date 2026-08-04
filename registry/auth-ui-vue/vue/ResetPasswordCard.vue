<script setup lang="ts">
import { queryParameter } from "../core/browser-location";
import { createResetPasswordController } from "../core/reset-password";
import AuthCard from "./AuthCard.vue";
import FormField from "./FormField.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUI } from "./provider";
import SubmitButton from "./SubmitButton.vue";
import { useController } from "./use-controller";

const props = defineProps<{
    /** Defaults to `?token=` from the URL. */
    token?: string;
}>();

const { localization: t } = useAuthUI();
// Captured at setup: the controller consumes the token once on creation, so a
// token that changes afterwards means a new card, not a new state.
const token = props.token ?? queryParameter("token");
const { actions, state } = useController((context) => createResetPasswordController(context, { token }));
</script>

<template>
    <AuthCard :title="t.resetPassword">
        <form class="lunora-auth-form" novalidate @submit.prevent="actions.submit">
            <FormBanner :error="state.formError" :success="state.successMessage" />
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
