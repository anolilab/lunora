<script setup lang="ts">
import { createChangePasswordController } from "../core/change-password";
import AuthCard from "./AuthCard.vue";
import Field from "./Field.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUI } from "./provider";
import SubmitButton from "./SubmitButton.vue";
import { useController } from "./use-controller";

const { localization: t } = useAuthUI();
const { actions, state } = useController(createChangePasswordController);
</script>

<template>
    <AuthCard :title="t.changePassword">
        <form class="lunora-auth-form" novalidate @submit.prevent="actions.submit">
            <FormBanner :error="state.formError" :success="state.successMessage" />
            <Field
                :field="state.fields.currentPassword"
                :label="t.currentPasswordLabel"
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                @blur="actions.blur('currentPassword')"
                @change="actions.setField('currentPassword', $event)"
            />
            <Field
                :field="state.fields.newPassword"
                :label="t.newPasswordLabel"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                @blur="actions.blur('newPassword')"
                @change="actions.setField('newPassword', $event)"
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
            <SubmitButton :pending="state.status === 'submitting'">{{ t.changePassword }}</SubmitButton>
        </form>
    </AuthCard>
</template>
