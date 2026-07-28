<script setup lang="ts">
// The accounts signed in on *this device*, with switch and sign-out-just-this.
//
// Not <SessionsCard>, which lists this account's sessions across every device.
// The two are a keystroke apart in better-auth's API and mean opposite things.
import { isFlowEnabled } from "../core/flow-gate";
import { createDeviceSessionsController } from "../core/multi-session";
import AuthCard from "./AuthCard.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUI } from "./provider";
import Skeleton from "./Skeleton.vue";
import { useController } from "./use-controller";
import UserView from "./UserView.vue";

const context = useAuthUI();
const t = context.localization;
// Resolved before the controller is built: a gated-off card must not fire the
// resource auto-load on mount just to render nothing.
const enabled = isFlowEnabled(context, "multiSession", "MultiSessionCard");
const { actions, state } = useController((context_) => createDeviceSessionsController(context_, { autoLoad: enabled }));

// Takes the optional token straight from the row: the template can't narrow,
// so the guard lives here rather than as a cast at the call site.
const onSetActive = (token?: string): void => {
    void actions.setActive(token ?? "");
};

const onRevoke = (token?: string): void => {
    void actions.revoke(token ?? "");
};
</script>

<template>
    <AuthCard v-if="enabled" :title="t.multiSessionTitle">
        <FormBanner :error="state.error" />
        <Skeleton v-if="state.loading" :rows="2" />
        <ul v-else class="lunora-auth-list">
            <li v-for="entry in state.items" :key="entry.session?.token ?? entry.user?.id" class="lunora-auth-list__item">
                <UserView compact :user="entry.user" />
                <span class="lunora-auth-list__actions">
                    <button
                        class="lunora-auth-button lunora-auth-button--secondary"
                        type="button"
                        :disabled="state.busy"
                        @click="onSetActive(entry.session?.token)"
                    >
                        {{ t.switchAccount }}
                    </button>
                    <button class="lunora-auth-button lunora-auth-button--danger" type="button" :disabled="state.busy" @click="onRevoke(entry.session?.token)">
                        {{ t.signOut }}
                    </button>
                </span>
            </li>
            <li v-if="state.items.length === 0" class="lunora-auth-list__empty">{{ t.multiSessionEmpty }}</li>
        </ul>
    </AuthCard>
</template>
