<script setup lang="ts">
// Approve or deny a device code.
//
// A code arriving in the URL prefills the field and never submits: a link that
// silently grants access to whatever device sent it is exactly what this flow
// exists to make visible.
import { computed } from "vue";

import { createDeviceAuthorizationController } from "../core/device-authorization";
import { isFlowEnabled } from "../core/flow-gate";
import AuthCard from "./AuthCard.vue";
import Field from "./Field.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUIContextRef } from "./provider";
import { queryParameter } from "./query-parameter";
import { useController } from "./use-controller";

const props = defineProps<{
    /** Defaults to `?user_code=` from the URL. */
    userCode?: string;
}>();

const context = useAuthUIContextRef();
const t = context.value.localization;
// Computed, not read at setup: `setup()` never re-runs, so a gate resolved here
// would stay frozen on the pre-discovery answer. See `provider.ts`.
const enabled = computed(() => isFlowEnabled(context.value, "deviceAuthorization", "DeviceAuthorizationCard"));
// Captured at setup: it only ever seeds the field, so a later change means a new
// card rather than a new state.
const userCode = props.userCode ?? queryParameter("user_code");
const { actions, state } = useController((context_) => createDeviceAuthorizationController(context_, { userCode }));

const onApprove = (): void => {
    void actions.approve();
};

const onDeny = (): void => {
    void actions.deny();
};
</script>

<template>
    <AuthCard v-if="enabled && state.decision !== undefined" :title="t.deviceTitle">
        <FormBanner :success="state.decision === 'approved' ? t.deviceApproved : t.deviceDenied" />
    </AuthCard>
    <AuthCard v-else-if="enabled" :title="t.deviceTitle">
        <FormBanner :error="state.error" />
        <Field :field="{ touched: false, value: state.code }" :label="t.deviceCodeLabel" name="user_code" @change="actions.setCode" />
        <div class="lunora-auth-actions">
            <button class="lunora-auth-button" type="button" :disabled="state.status === 'submitting'" @click="onApprove">{{ t.deviceApprove }}</button>
            <button class="lunora-auth-button lunora-auth-button--secondary" type="button" :disabled="state.status === 'submitting'" @click="onDeny">
                {{ t.deviceDeny }}
            </button>
        </div>
    </AuthCard>
</template>
