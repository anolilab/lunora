<script setup lang="ts">
import { createDeleteAccountController } from "../core/delete-account";
import AuthCard from "./AuthCard.vue";
import FormField from "./FormField.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUI } from "./provider";
import SubmitButton from "./SubmitButton.vue";
import { useController } from "./use-controller";

const { localization: t } = useAuthUI();
const { actions, state } = useController(createDeleteAccountController);
</script>

<template>
    <AuthCard :title="t.deleteAccount" :description="t.deleteAccountWarning" :headingLevel="2">
        <form class="lunora-auth-form" novalidate @submit.prevent="actions.submit">
            <FormBanner :error="state.formError" />
            <FormField :actions="actions" field="password" :fields="state.fields" :label="t.passwordLabel" type="password" autoComplete="current-password" />
            <SubmitButton :pending="state.status === 'submitting'">{{ t.deleteAccount }}</SubmitButton>
        </form>
    </AuthCard>
</template>
