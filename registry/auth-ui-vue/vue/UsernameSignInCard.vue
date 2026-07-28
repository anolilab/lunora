<script setup lang="ts">
// Sign in with a username instead of an email.
import { isFlowEnabled } from "../core/flow-gate";
import { createUsernameSignInController } from "../core/username";
import AuthCard from "./AuthCard.vue";
import Field from "./Field.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUI } from "./provider";
import SubmitButton from "./SubmitButton.vue";
import { useController } from "./use-controller";

const context = useAuthUI();
const t = context.localization;
const enabled = isFlowEnabled(context, "username", "UsernameSignInCard");
const { actions, state } = useController(createUsernameSignInController);
</script>

<template>
    <AuthCard v-if="enabled" :title="t.signIn">
        <form class="lunora-auth-form" novalidate @submit.prevent="actions.submit">
            <FormBanner :error="state.formError" />
            <Field
                :field="state.fields.username"
                :label="t.usernameLabel"
                name="username"
                autoComplete="username"
                @blur="actions.blur('username')"
                @change="actions.setField('username', $event)"
            />
            <Field
                :field="state.fields.password"
                :label="t.passwordLabel"
                name="password"
                type="password"
                autoComplete="current-password"
                @blur="actions.blur('password')"
                @change="actions.setField('password', $event)"
            />
            <SubmitButton :pending="state.status === 'submitting'">{{ t.signIn }}</SubmitButton>
        </form>
    </AuthCard>
</template>
