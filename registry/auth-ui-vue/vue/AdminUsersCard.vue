<script setup lang="ts">
// The admin plugin's user table.
//
// Every action here is destructive or privilege-changing, so none of them are
// optimistic and none are one click from a row's primary target — impersonation
// in particular navigates away rather than mutating in place, because the whole
// app is a different user afterwards.
import { computed } from "vue";

import type { AuthAdminUser } from "../core/types";
import { createAdminUsersController } from "../core/admin-users";
import { isFlowEnabled } from "../core/flow-gate";
import { ROLE_OPTIONS } from "../core/labels";
import AuthCard from "./AuthCard.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUIContextRef } from "./provider";
import Skeleton from "./Skeleton.vue";
import { useController } from "./use-controller";

const context = useAuthUIContextRef();
const t = context.value.localization;
// Computed, not read at setup: `setup()` never re-runs, so a gate resolved here
// would stay frozen on the pre-discovery answer. See `provider.ts`.
const enabled = computed(() => isFlowEnabled(context.value, "admin", "AdminUsersCard"));
// Read inside the factory rather than captured: `useController` re-runs it when
// the discovered context lands, and a gated-off card must not fire the resource
// auto-load just to render nothing.
const { actions, state } = useController((context_) => createAdminUsersController(context_, { autoLoad: enabled.value }));

// "user" is the role better-auth assigns when none was set, so it heads the list
// even though it is not one of the invitable roles.
const roleOptions: ReadonlyArray<string> = ["user", ...ROLE_OPTIONS];

const onSearch = (event: Event): void => {
    void actions.setSearch((event.target as HTMLInputElement).value);
};

const onRole = (user: AuthAdminUser, event: Event): void => {
    void actions.setRole(user.id ?? "", (event.target as HTMLSelectElement).value);
};

const onImpersonate = (user: AuthAdminUser): void => {
    void actions.impersonate(user.id ?? "");
};

const onBanToggle = (user: AuthAdminUser): void => {
    void (user.banned === true ? actions.unban(user.id ?? "") : actions.ban(user.id ?? ""));
};
</script>

<template>
    <AuthCard v-if="enabled" :title="t.adminTitle">
        <FormBanner :error="state.error" />
        <input
            class="lunora-auth-field__input"
            type="search"
            :aria-label="t.adminSearch"
            :placeholder="t.adminSearch"
            :value="state.search"
            @input="onSearch"
        />
        <Skeleton v-if="state.loading" />
        <ul v-else class="lunora-auth-list">
            <li v-for="user in state.items" :key="user.id" class="lunora-auth-list__item">
                <span class="lunora-auth-list__label">
                    {{ user.email }}
                    <span v-if="user.banned === true" class="lunora-auth-badge">{{ t.adminBan }}</span>
                </span>
                <span class="lunora-auth-list__actions">
                    <select
                        class="lunora-auth-select"
                        :aria-label="t.roleLabel"
                        :disabled="state.busy"
                        :value="user.role ?? 'user'"
                        @change="onRole(user, $event)"
                    >
                        <option v-for="role in roleOptions" :key="role" :value="role">{{ role }}</option>
                    </select>
                    <button class="lunora-auth-button lunora-auth-button--secondary" type="button" :disabled="state.busy" @click="onImpersonate(user)">
                        {{ t.adminImpersonate }}
                    </button>
                    <button class="lunora-auth-button lunora-auth-button--danger" type="button" :disabled="state.busy" @click="onBanToggle(user)">
                        {{ user.banned === true ? t.adminUnban : t.adminBan }}
                    </button>
                </span>
            </li>
            <li v-if="state.items.length === 0" class="lunora-auth-list__empty">{{ t.adminUsersEmpty }}</li>
        </ul>
    </AuthCard>
</template>
