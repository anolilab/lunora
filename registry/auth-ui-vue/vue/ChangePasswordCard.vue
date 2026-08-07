<script setup lang="ts">
import { createChangePasswordController } from "../core/change-password";
import AuthCard from "./AuthCard.vue";
import FormField from "./FormField.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUI } from "./provider";
import SubmitButton from "./SubmitButton.vue";
import { useController } from "./use-controller";

const { localization: t } = useAuthUI();
const { actions, state } = useController(createChangePasswordController);
</script>

<template>
    <AuthCard :headingLevel="2" :title="t.changePassword">
        <form class="lunora-auth-form" novalidate @submit.prevent="actions.submit">
            <FormBanner :error="state.formError" :success="state.successMessage" />
            <FormField
                :actions="actions"
                field="currentPassword"
                :fields="state.fields"
                :label="t.currentPasswordLabel"
                type="password"
                autoComplete="current-password"
            />
            <FormField :actions="actions" field="newPassword" :fields="state.fields" :label="t.newPasswordLabel" type="password" autoComplete="new-password" />
            <FormField
                :actions="actions"
                field="confirmPassword"
                :fields="state.fields"
                :label="t.confirmPasswordLabel"
                type="password"
                autoComplete="new-password"
            />
            <SubmitButton :pending="state.status === 'submitting'">{{ t.changePassword }}</SubmitButton>
        </form>
    </AuthCard>
</template>
