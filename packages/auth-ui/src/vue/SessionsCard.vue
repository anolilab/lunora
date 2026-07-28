<script setup lang="ts">
import { sessionLabel } from "../core/labels";
import { createSessionsController } from "../core/sessions";
import AuthCard from "./AuthCard.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUI } from "./provider";
import { useController } from "./use-controller";

const { localization: t } = useAuthUI();
const { actions, state } = useController(createSessionsController);

// Takes the optional id straight from the row: the template can't narrow,
// so the guard lives here rather than as a cast at the call site.
const onRevoke = (token?: string): void => {
    if (token !== undefined) {
        void actions.revoke(token);
    }
};

const onRevokeOthers = (): void => {
    void actions.revokeOthers();
};
</script>

<template>
    <AuthCard :title="t.sessions">
        <FormBanner :error="state.error" />
        <p v-if="state.loading" class="lunora-auth-card__description">…</p>
        <p v-else-if="state.items.length === 0" class="lunora-auth-card__description">{{ t.sessionsEmpty }}</p>
        <ul v-else class="lunora-auth-list">
            <li v-for="session in state.items" :key="session.id ?? session.token ?? sessionLabel(session, t)" class="lunora-auth-list__item">
                <span class="lunora-auth-list__label">{{ sessionLabel(session, t) }}</span>
                <button v-if="session.token !== undefined" class="lunora-auth-link" type="button" :disabled="state.busy" @click="onRevoke(session.token)">
                    {{ t.revoke }}
                </button>
            </li>
        </ul>
        <button class="lunora-auth-button lunora-auth-button--secondary" type="button" :disabled="state.busy" @click="onRevokeOthers">
            {{ t.revokeOthers }}
        </button>
    </AuthCard>
</template>
