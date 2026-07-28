<script setup lang="ts">
// Avatar upload. Rendered only when the app configured an `avatar.upload`
// handler — without one there is nowhere to put the bytes, and <ProfileCard>'s
// URL field is the honest fallback.
import { useTemplateRef } from "vue";

import { ACCEPT_ATTRIBUTE, createAvatarUploadController } from "../core/avatar";
import AuthCard from "./AuthCard.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUI } from "./provider";
import { useController } from "./use-controller";
import UserAvatar from "./UserAvatar.vue";

const context = useAuthUI();
const t = context.localization;
const { actions, state } = useController(createAvatarUploadController);
const picker = useTemplateRef<HTMLInputElement>("picker");

const onPick = (event: Event): void => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    // Clear the input so re-picking the same file after a failure still fires
    // `change` — browsers suppress it when the value is unchanged.
    input.value = "";

    if (file) {
        void actions.upload(file);
    }
};

const onBrowse = (): void => {
    picker.value?.click();
};

const onRemove = (): void => {
    void actions.remove();
};
</script>

<template>
    <AuthCard v-if="context.avatar.upload !== undefined" :title="t.avatar">
        <FormBanner :error="state.error" />
        <div class="lunora-auth-avatar-row">
            <UserAvatar :size="64" :user="{ image: state.imageUrl }" />
            <div class="lunora-auth-avatar-row__actions">
                <input ref="picker" class="lunora-auth-visually-hidden" type="file" :accept="ACCEPT_ATTRIBUTE" @change="onPick" />
                <button class="lunora-auth-button" type="button" :disabled="state.status === 'submitting'" @click="onBrowse">{{ t.avatarUpload }}</button>
                <button
                    v-if="state.imageUrl !== undefined && state.imageUrl !== ''"
                    class="lunora-auth-button lunora-auth-button--danger"
                    type="button"
                    :disabled="state.status === 'submitting'"
                    @click="onRemove"
                >
                    {{ t.avatarRemove }}
                </button>
            </div>
        </div>
    </AuthCard>
</template>
