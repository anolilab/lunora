<script setup lang="ts">
// Every invitation waiting for the signed-in user, decidable in place.
import { createUserInvitationsController } from "../core/invitations";
import AuthCard from "./AuthCard.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUI } from "./provider";
import Skeleton from "./Skeleton.vue";
import { useController } from "./use-controller";

const { localization: t } = useAuthUI();
const { actions, state } = useController(createUserInvitationsController);

// Takes the optional id straight from the row: the template can't narrow,
// so the guard lives here rather than as a cast at the call site.
const onAccept = (id?: string): void => {
    void actions.accept(id ?? "");
};

const onReject = (id?: string): void => {
    void actions.reject(id ?? "");
};
</script>

<template>
    <AuthCard :title="t.invitations">
        <FormBanner :error="state.error" />
        <Skeleton v-if="state.loading" :rows="2" />
        <ul v-else class="lunora-auth-list">
            <li v-for="invitation in state.items" :key="invitation.id" class="lunora-auth-list__item">
                <span class="lunora-auth-list__label">{{ invitation.organizationName ?? invitation.email }}</span>
                <span class="lunora-auth-list__actions">
                    <button class="lunora-auth-button" type="button" :disabled="state.busy" @click="onAccept(invitation.id)">
                        {{ t.invitationAccept }}
                    </button>
                    <button class="lunora-auth-button lunora-auth-button--secondary" type="button" :disabled="state.busy" @click="onReject(invitation.id)">
                        {{ t.invitationReject }}
                    </button>
                </span>
            </li>
            <li v-if="state.items.length === 0" class="lunora-auth-list__empty">{{ t.invitationsEmpty }}</li>
        </ul>
    </AuthCard>
</template>
