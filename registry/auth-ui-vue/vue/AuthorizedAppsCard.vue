<script setup lang="ts">
// Applications the user has authorized, with revoke — the place a granted
// consent can be taken back. Without it, the consent screen is a one-way door.
import { computed } from "vue";

import { isFlowEnabled } from "../core/flow-gate";
import { createAuthorizedAppsController } from "../core/oauth-provider";
import AuthCard from "./AuthCard.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUIContextRef } from "./provider";
import Skeleton from "./Skeleton.vue";
import { useController } from "./use-controller";

const context = useAuthUIContextRef();
const t = context.value.localization;
// Computed, not read at setup: `setup()` never re-runs, so a gate resolved here
// would stay frozen on the pre-discovery answer. See `provider.ts`.
const enabled = computed(() => isFlowEnabled(context.value, "oauthProvider", "AuthorizedAppsCard"));
// Read inside the factory rather than captured: `useController` re-runs it when
// the discovered context lands, and a gated-off card must not fire the resource
// auto-load just to render nothing.
const { actions, state } = useController((context_) => createAuthorizedAppsController(context_, { autoLoad: enabled.value }));

// Takes the optional id straight from the row: the template can't narrow, so
// the fallback lives here rather than as a cast at the call site.
const onRevoke = (consentId?: string): void => {
    void actions.revoke(consentId ?? "");
};
</script>

<template>
    <AuthCard v-if="enabled" :title="t.authorizedApps">
        <FormBanner :error="state.error" />
        <Skeleton v-if="state.loading" :rows="2" />
        <ul v-else class="lunora-auth-list">
            <li v-for="consent in state.items" :key="consent.id ?? consent.clientId" class="lunora-auth-list__item">
                <span class="lunora-auth-list__label">{{ consent.clientName ?? consent.clientId }}</span>
                <button class="lunora-auth-button lunora-auth-button--danger" type="button" :disabled="state.busy" @click="onRevoke(consent.id)">
                    {{ t.revokeAccess }}
                </button>
            </li>
            <li v-if="state.items.length === 0" class="lunora-auth-list__empty">{{ t.authorizedAppsEmpty }}</li>
        </ul>
    </AuthCard>
</template>
