<script setup lang="ts">
import { ref } from "vue";

import { createMembersController, isFlowEnabled } from "../core";
import AuthCard from "./AuthCard.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUI } from "./provider";
import SubmitButton from "./SubmitButton.vue";
import { useController } from "./use-controller";

const ROLE_OPTIONS = ["member", "admin", "owner"] as const;

const context = useAuthUI();
const t = context.localization;
const enabled = isFlowEnabled(context, "organization", "MembersCard");
const { actions, state } = useController((context_) => createMembersController(context_, { autoLoad: enabled }));

const email = ref("");
const role = ref<string>("member");

const invite = (): void => {
    if (email.value.trim() === "") {
        return;
    }

    void actions.invite(email.value.trim(), role.value);
    email.value = "";
};

const onRemoveMember = (id: string): void => {
    void actions.removeMember(id);
};

const onCancelInvitation = (id: string): void => {
    void actions.cancelInvitation(id);
};
</script>

<template>
    <AuthCard v-if="enabled" :title="t.members">
        <FormBanner :error="state.error" />

        <p v-if="state.loading" class="lunora-auth-card__description">…</p>
        <ul v-else class="lunora-auth-list">
            <li v-for="member in state.members" :key="member.id ?? member.userId ?? member.user?.email" class="lunora-auth-list__item">
                <span class="lunora-auth-list__label">{{ member.user?.email ?? member.user?.name ?? member.userId }} · {{ member.role }}</span>
                <button
                    v-if="member.id !== undefined"
                    class="lunora-auth-link"
                    type="button"
                    :disabled="state.busy"
                    @click="onRemoveMember(member.id as string)"
                >
                    {{ t.remove }}
                </button>
            </li>
        </ul>

        <template v-if="state.invitations.length > 0">
            <p class="lunora-auth-card__description">{{ t.invitations }}</p>
            <ul class="lunora-auth-list">
                <li v-for="invitation in state.invitations" :key="invitation.id ?? invitation.email" class="lunora-auth-list__item">
                    <span class="lunora-auth-list__label">{{ invitation.email }} · {{ invitation.role }}</span>
                    <button
                        v-if="invitation.id !== undefined"
                        class="lunora-auth-link"
                        type="button"
                        :disabled="state.busy"
                        @click="onCancelInvitation(invitation.id as string)"
                    >
                        {{ t.cancel }}
                    </button>
                </li>
            </ul>
        </template>

        <form class="lunora-auth-form" novalidate @submit.prevent="invite">
            <div class="lunora-auth-field">
                <label class="lunora-auth-field__label" for="lunora-invite-email">{{ t.inviteEmailLabel }}</label>
                <input id="lunora-invite-email" v-model="email" class="lunora-auth-field__input" type="email" />
            </div>
            <div class="lunora-auth-field">
                <label class="lunora-auth-field__label" for="lunora-invite-role">{{ t.roleLabel }}</label>
                <select id="lunora-invite-role" v-model="role" class="lunora-auth-field__input">
                    <option v-for="option in ROLE_OPTIONS" :key="option" :value="option">{{ option }}</option>
                </select>
            </div>
            <SubmitButton :pending="state.busy">{{ t.inviteMember }}</SubmitButton>
        </form>
    </AuthCard>
</template>
