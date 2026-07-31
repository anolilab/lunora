<script setup lang="ts">
import { createChangeEmailController } from "../core/change-email";
import AuthCard from "./AuthCard.vue";
import Field from "./Field.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUI } from "./provider";
import SubmitButton from "./SubmitButton.vue";
import { useController } from "./use-controller";

const { localization: t } = useAuthUI();
const { actions, state } = useController(createChangeEmailController);
</script>

<template>
    <AuthCard :headingLevel="2" :title="t.changeEmail">
        <form class="lunora-auth-form" novalidate @submit.prevent="actions.submit">
            <FormBanner :error="state.formError" :success="state.successMessage" />
            <Field
                :field="state.fields.newEmail"
                :label="t.newEmailLabel"
                name="newEmail"
                type="email"
                autoComplete="email"
                @blur="actions.blur('newEmail')"
                @change="actions.setField('newEmail', $event)"
            />
            <SubmitButton :pending="state.status === 'submitting'">{{ t.changeEmail }}</SubmitButton>
        </form>
    </AuthCard>
</template>
