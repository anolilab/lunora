<script setup lang="ts">
import { computed } from "vue";

import { isFlowEnabled } from "../core/flow-gate";
import { createTwoFactorSetupController } from "../core/two-factor-setup";
import AuthCard from "./AuthCard.vue";
import Field from "./Field.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUIContextRef } from "./provider";
import SubmitButton from "./SubmitButton.vue";
import { useController } from "./use-controller";

const context = useAuthUIContextRef();
const t = context.value.localization;
// Computed, not read at setup: `setup()` never re-runs, so a gate resolved here
// would stay frozen on the pre-discovery answer. See `provider.ts`.
const enabled = computed(() => isFlowEnabled(context.value, "twoFactor", "TwoFactorSetupCard"));
const { actions, state } = useController(createTwoFactorSetupController);
</script>

<template>
    <AuthCard v-if="enabled && state.step === 'enabled'" :title="t.twoFactorSetup">
        <FormBanner :error="state.error" :success="t.twoFactorEnabled" />
        <form class="lunora-auth-form" novalidate @submit.prevent="actions.disable">
            <Field
                :field="state.password"
                :label="t.passwordLabel"
                name="password"
                type="password"
                autoComplete="current-password"
                @change="actions.setPassword"
            />
            <SubmitButton :pending="state.status === 'submitting'">{{ t.twoFactorDisable }}</SubmitButton>
        </form>
    </AuthCard>
    <AuthCard v-else-if="enabled && state.step === 'verify'" :title="t.twoFactorSetup" :description="t.twoFactorScan">
        <FormBanner :error="state.error" />
        <code v-if="state.totpUri !== undefined" class="lunora-auth-code">{{ state.totpUri }}</code>
        <template v-if="state.backupCodes.length > 0">
            <p class="lunora-auth-card__description">{{ t.backupCodes }}</p>
            <ul class="lunora-auth-codes">
                <li v-for="backupCode in state.backupCodes" :key="backupCode" class="lunora-auth-codes__item">{{ backupCode }}</li>
            </ul>
        </template>
        <form class="lunora-auth-form" novalidate @submit.prevent="actions.verify">
            <Field :field="state.code" :label="t.codeLabel" name="code" autoComplete="one-time-code" @change="actions.setCode" />
            <SubmitButton :pending="state.status === 'submitting'">{{ t.twoFactor }}</SubmitButton>
        </form>
    </AuthCard>
    <AuthCard v-else-if="enabled" :title="t.twoFactorSetup">
        <FormBanner :error="state.error" />
        <form class="lunora-auth-form" novalidate @submit.prevent="actions.enable">
            <Field
                :field="state.password"
                :label="t.passwordLabel"
                name="password"
                type="password"
                autoComplete="current-password"
                @change="actions.setPassword"
            />
            <SubmitButton :pending="state.status === 'submitting'">{{ t.twoFactorEnable }}</SubmitButton>
        </form>
    </AuthCard>
</template>
