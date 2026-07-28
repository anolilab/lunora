<script setup lang="ts">
// Which OAuth providers are attached, with link/unlink.
//
// The "available to link" list is `context.social` minus what is already
// attached — so with server discovery on, it is exactly the providers the
// deployment configured, and an app that adds one gets a new button with no
// client change.
import { computed } from "vue";

import type { AuthAccount } from "../core/types";
import { createAccountsController, NON_SOCIAL_PROVIDERS } from "../core/accounts";
import { providerLabel } from "../core/labels";
import AuthCard from "./AuthCard.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUIContextRef } from "./provider";
import Skeleton from "./Skeleton.vue";
import { useController } from "./use-controller";

// The context *ref*: `linkable` below reads `social`, which discovery fills in,
// so the computed has to track it rather than close over one snapshot.
const context = useAuthUIContextRef();
const t = context.value.localization;
const { actions, state } = useController(createAccountsController);

const linkable = computed(() => {
    const linked = new Set(state.value.items.map((account) => account.providerId).filter((id): id is string => id !== undefined));

    return context.value.social.filter((provider) => !linked.has(provider));
});

const onUnlink = (account: AuthAccount): void => {
    void actions.unlink(account.providerId ?? "", account.accountId);
};

const onLink = (provider: string): void => {
    void actions.link(provider);
};
</script>

<template>
    <AuthCard :title="t.accountsTitle">
        <FormBanner :error="state.error" />
        <Skeleton v-if="state.loading" />
        <ul v-else class="lunora-auth-list">
            <li v-for="account in state.items" :key="account.id ?? account.providerId" class="lunora-auth-list__item">
                <span class="lunora-auth-list__label">{{ providerLabel(account.providerId ?? "") }}</span>
                <!--
                    `credential` is the password and `passkey` rows belong to
                    <PasskeysCard>; offering "unlink" for either would be a
                    button that either fails or deletes the wrong thing.
                -->
                <button
                    v-if="!NON_SOCIAL_PROVIDERS.has(account.providerId ?? '')"
                    class="lunora-auth-button lunora-auth-button--danger"
                    type="button"
                    :disabled="state.busy || state.items.length <= 1"
                    @click="onUnlink(account)"
                >
                    {{ t.remove }}
                </button>
            </li>
            <li v-if="state.items.length === 0" class="lunora-auth-list__empty">{{ t.accountsEmpty }}</li>
        </ul>
        <div v-if="linkable.length > 0" class="lunora-auth-social">
            <button
                v-for="provider in linkable"
                :key="provider"
                class="lunora-auth-button lunora-auth-button--secondary"
                type="button"
                :disabled="state.busy"
                @click="onLink(provider)"
            >
                {{ `${t.accountsLink}: ${providerLabel(provider)}` }}
            </button>
        </div>
    </AuthCard>
</template>
