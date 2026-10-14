<script setup lang="ts">
// Avatar upload. Rendered only when the app configured an `avatar.upload`
// handler — without one there is nowhere to put the bytes, and <ProfileCard>'s
// URL field is the honest fallback.
import { useId } from "vue";

import { ACCEPT_ATTRIBUTE, createAvatarUploadController } from "../core/avatar";
import AuthCard from "./AuthCard.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUIContextRef } from "./provider";
import { useController } from "./use-controller";
import UserAvatar from "./UserAvatar.vue";

// The context *ref*, so the template's `avatar.upload` gate re-reads it rather
// than freezing on the value `setup()` saw. See `provider.ts`.
const context = useAuthUIContextRef();
const t = context.value.localization;
const { actions, state } = useController(createAvatarUploadController);
const pickerId = useId();

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
                <!--
                    A label wrapping the input, not a button that clicks it: the
                    input is the only control, so there is one tab stop, the label
                    text is its accessible name, and Enter or Space opens the
                    picker natively. The input stays focusable and out of the ARIA
                    tree's way — `aria-hidden` on something focusable is what
                    leaves focus with no accessible target.
                -->
                <label class="lunora-auth-button" :for="pickerId">
                    <input
                        :id="pickerId"
                        class="lunora-auth-visually-hidden"
                        type="file"
                        :accept="ACCEPT_ATTRIBUTE"
                        :disabled="state.status === 'submitting'"
                        @change="onPick"
                    />
                    {{ t.avatarUpload }}
                </label>
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
