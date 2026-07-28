<script setup lang="ts">
import { createResetPasswordController } from "../core/reset-password";
import AuthCard from "./AuthCard.vue";
import Field from "./Field.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUI } from "./provider";
import SubmitButton from "./SubmitButton.vue";
import { useController } from "./use-controller";

const props = defineProps<{
    /** The reset token from the URL (`?token=...`). */
    token?: string;
}>();

const { localization: t } = useAuthUI();
const { actions, state } = useController((context) => createResetPasswordController(context, { token: props.token }));
</script>

<template>
    <AuthCard :title="t.resetPassword">
        <form class="lunora-auth-form" novalidate @submit.prevent="actions.submit">
            <FormBanner :error="state.formError" :success="state.successMessage" />
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
