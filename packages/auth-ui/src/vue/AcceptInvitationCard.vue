<script setup lang="ts">
// The screen an organization invitation link lands on.
//
// It renders the organization's name before asking for a decision — an "Accept"
// button with nothing above it is not consent — and bounces through sign-in when
// there is no session, returning to this same invitation afterwards.
import { createAcceptInvitationController } from "../core/invitations";
import AuthCard from "./AuthCard.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUI } from "./provider";
import { queryParameter } from "./query-parameter";
import Skeleton from "./Skeleton.vue";
import { useController } from "./use-controller";

const props = defineProps<{
    /** Defaults to `?invitationId=` from the URL. */
    invitationId?: string;
}>();

const { localization: t } = useAuthUI();
// Captured at setup: the controller loads this one invitation on creation, so a
// different id means a different card, not a new state.
const invitationId = props.invitationId ?? queryParameter("invitationId");
const { actions, state } = useController((context) => createAcceptInvitationController(context, { invitationId }));

const onAccept = (): void => {
    void actions.accept();
};

const onReject = (): void => {
    void actions.reject();
};
</script>

<template>
    <AuthCard :title="t.invitationTitle" :description="state.invitation?.organizationName">
        <FormBanner :error="state.error" />
        <Skeleton v-if="state.loading" :rows="2" />
        <div v-else class="lunora-auth-actions">
            <button class="lunora-auth-button" type="button" :disabled="state.status === 'submitting' || state.invitation === undefined" @click="onAccept">
                {{ t.invitationAccept }}
            </button>
            <button
                class="lunora-auth-button lunora-auth-button--secondary"
                type="button"
                :disabled="state.status === 'submitting' || state.invitation === undefined"
                @click="onReject"
            >
                {{ t.invitationReject }}
            </button>
        </div>
    </AuthCard>
</template>
