<script setup lang="ts">
// Claim or change the username, when the `username` plugin is on.
import { computed } from "vue";

import { isFlowEnabled } from "../core/flow-gate";
import { createSetUsernameController } from "../core/username";
import { createUsernameAvailabilityController } from "../core/username-availability";
import AuthCard from "./AuthCard.vue";
import Field from "./Field.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUIContextRef } from "./provider";
import SubmitButton from "./SubmitButton.vue";
import { useController } from "./use-controller";
import UsernameAvailability from "./UsernameAvailability.vue";

const context = useAuthUIContextRef();
const t = context.value.localization;
// Computed, not read at setup: `setup()` never re-runs, so a gate resolved here
// would stay frozen on the pre-discovery answer. See `provider.ts`.
const enabled = computed(() => isFlowEnabled(context.value, "username", "SetUsernameCard"));
const { actions, state } = useController(createSetUsernameController);
// Checked as the user types, so a taken name surfaces here rather than as a
// failed save with the field already blurred.
const { actions: availabilityActions, state: availability } = useController(createUsernameAvailabilityController);

const onUsernameChange = (value: string): void => {
    actions.setField("username", value);
    availabilityActions.check(value);
};
</script>

<template>
    <AuthCard v-if="enabled" :title="t.usernameLabel">
        <form class="lunora-auth-form" novalidate @submit.prevent="actions.submit">
            <FormBanner :error="state.formError" :success="state.successMessage" />
            <Field
                :field="state.fields.username"
                :label="t.usernameLabel"
                name="username"
                autoComplete="username"
                @blur="actions.blur('username')"
                @change="onUsernameChange($event)"
            />
            <UsernameAvailability :status="availability.status" />
            <SubmitButton :pending="state.status === 'submitting'">{{ t.saveChanges }}</SubmitButton>
        </form>
    </AuthCard>
</template>
