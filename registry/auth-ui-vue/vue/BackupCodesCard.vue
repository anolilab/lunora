<script setup lang="ts">
// Regenerate two-factor backup codes.
//
// The new codes are shown once and never again — they are not refetchable by
// design — so they render inline on success rather than behind a navigation the
// user might not come back from.
import { computed, onScopeDispose, shallowRef } from "vue";

import { createBackupCodesController } from "../core/backup-codes";
import { isFlowEnabled } from "../core/flow-gate";
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
const enabled = computed(() => isFlowEnabled(context.value, "twoFactor", "BackupCodesCard"));
/*
 * The codes live on a second store beside the form (see `core/backup-codes.ts`),
 * so this card binds both: the form through `useController`, the codes through
 * their own subscription. `handle.controller.destroy` releases both.
 */
const handle = createBackupCodesController(context.value);
const { actions, state } = useController(() => handle.controller);

const codes = shallowRef<ReadonlyArray<string>>(handle.getCodes());
const stop = handle.subscribeCodes(() => {
    codes.value = handle.getCodes();
});

onScopeDispose(stop);
</script>

<template>
    <AuthCard v-if="enabled" :title="t.backupCodesRegenerate">
        <form class="lunora-auth-form" novalidate @submit.prevent="actions.submit">
            <FormBanner :error="state.formError" :success="state.successMessage" />
            <Field
                :field="state.fields.password"
                :label="t.currentPasswordLabel"
                name="password"
                type="password"
                autoComplete="current-password"
                @blur="actions.blur('password')"
                @change="actions.setField('password', $event)"
            />
            <SubmitButton :pending="state.status === 'submitting'">{{ t.backupCodesRegenerate }}</SubmitButton>
        </form>
        <template v-if="codes.length > 0">
            <p class="lunora-auth-note">{{ t.backupCodes }}</p>
            <ul class="lunora-auth-codes">
                <li v-for="code in codes" :key="code" class="lunora-auth-codes__item">{{ code }}</li>
            </ul>
        </template>
    </AuthCard>
</template>
