<script setup lang="ts">
// Sign in with a username instead of an email.
import { computed } from "vue";

import { isFlowEnabled } from "../core/flow-gate";
import { createUsernameSignInController } from "../core/username";
import AuthCard from "./AuthCard.vue";
import FormField from "./FormField.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUIContextRef } from "./provider";
import SubmitButton from "./SubmitButton.vue";
import { useController } from "./use-controller";

const context = useAuthUIContextRef();
const t = context.value.localization;
// Computed, not read at setup: `setup()` never re-runs, so a gate resolved here
// would stay frozen on the pre-discovery answer. See `provider.ts`.
const enabled = computed(() => isFlowEnabled(context.value, "username", "UsernameSignInCard"));
const { actions, state } = useController(createUsernameSignInController);
</script>

<template>
    <AuthCard v-if="enabled" :title="t.signIn">
        <form class="lunora-auth-form" novalidate @submit.prevent="actions.submit">
            <FormBanner :error="state.formError" />
            <FormField :actions="actions" field="username" :fields="state.fields" :label="t.usernameLabel" autoComplete="username" />
            <FormField :actions="actions" field="password" :fields="state.fields" :label="t.passwordLabel" type="password" autoComplete="current-password" />
            <SubmitButton :pending="state.status === 'submitting'">{{ t.signIn }}</SubmitButton>
        </form>
    </AuthCard>
</template>
