<script setup lang="ts">
import type { AuthSession } from "../core";
import { createSessionsController } from "../core";
import AuthCard from "./AuthCard.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUI } from "./provider";
import { useController } from "./use-controller";

const { localization: t } = useAuthUI();
const { actions, state } = useController(createSessionsController);

const sessionLabel = (session: AuthSession): string => {
    const agent = session.userAgent?.trim();

    return agent === undefined || agent === "" ? (session.ipAddress ?? "Unknown device") : agent;
};

const onRevoke = (token: string): void => {
    void actions.revoke(token);
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
            <li v-for="session in state.items" :key="session.id ?? session.token ?? sessionLabel(session)" class="lunora-auth-list__item">
                <span class="lunora-auth-list__label">{{ sessionLabel(session) }}</span>
                <button
                    v-if="session.token !== undefined"
                    class="lunora-auth-link"
                    type="button"
                    :disabled="state.busy"
                    @click="onRevoke(session.token as string)"
                >
                    {{ t.revoke }}
                </button>
            </li>
        </ul>
        <button class="lunora-auth-button lunora-auth-button--secondary" type="button" :disabled="state.busy" @click="onRevokeOthers">
            {{ t.revokeOthers }}
        </button>
    </AuthCard>
</template>
