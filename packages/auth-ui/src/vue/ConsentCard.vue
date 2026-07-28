<script setup lang="ts">
// The consent screen a third-party application redirects the user into.
//
// Deliberately plain: it names the application, lists exactly what it is asking
// for, and offers two equally-weighted answers. Nothing is pre-selected and
// there is no "remember this" shortcut — an authorization prompt that is easier
// to approve than to read is the failure mode this screen exists to avoid.
import { computed } from "vue";

import { isFlowEnabled } from "../core/flow-gate";
import { createConsentController, scopeLabels } from "../core/oauth-provider";
import AuthCard from "./AuthCard.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUIContextRef } from "./provider";
import { queryParameter } from "./query-parameter";
import Skeleton from "./Skeleton.vue";
import { useController } from "./use-controller";

const props = defineProps<{
    /** Defaults to `?consent_id=` from the URL. */
    consentId?: string;
}>();

const context = useAuthUIContextRef();
const t = context.value.localization;
// Computed, not read at setup: `setup()` never re-runs, so a gate resolved here
// would stay frozen on the pre-discovery answer. See `provider.ts`.
const enabled = computed(() => isFlowEnabled(context.value, "oauthProvider", "ConsentCard"));
// Captured at setup: the controller loads this one request on creation, so a
// different id means a different card, not a new state.
const consentId = props.consentId ?? queryParameter("consent_id");
// `enabled.value` is read inside the factory rather than captured: `useController`
// re-runs it when the discovered context lands, and a gated-off card must not
// fetch a pending authorization request just to render nothing.
const { actions, state } = useController((context_) => createConsentController(context_, { autoLoad: enabled.value, consentId }));

const application = computed(() => state.value.request?.clientName ?? state.value.request?.clientId);
const scopes = computed(() => scopeLabels(state.value.request?.scope));
const pending = computed(() => state.value.status === "submitting");

const onDeny = (): void => {
    void actions.deny();
};

const onAllow = (): void => {
    void actions.accept();
};
</script>

<template>
    <AuthCard v-if="enabled" :title="t.consentTitle">
        <FormBanner :error="state.error" />
        <Skeleton v-if="state.loading" :rows="3" />
        <template v-else-if="state.request !== undefined">
            <p class="lunora-auth-note">
                <strong>{{ application }}</strong> {{ t.consentWants }}
            </p>
            <ul class="lunora-auth-list">
                <li v-for="scope in scopes" :key="scope" class="lunora-auth-list__item">
                    <span class="lunora-auth-list__label">{{ scope }}</span>
                </li>
            </ul>
            <div class="lunora-auth-actions">
                <!-- Deny first in the DOM: it is the safe answer, so it is the one a keyboard reaches first. -->
                <button class="lunora-auth-button lunora-auth-button--secondary" type="button" :disabled="pending" @click="onDeny">
                    {{ t.consentDeny }}
                </button>
                <button class="lunora-auth-button" type="button" :disabled="pending" @click="onAllow">{{ t.consentAllow }}</button>
            </div>
        </template>
    </AuthCard>
</template>
