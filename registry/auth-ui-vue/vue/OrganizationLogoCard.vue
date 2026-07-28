<script setup lang="ts">
// Upload an organization's logo. Rendered only when the app configured an
// `avatar.upload` handler — without one, <OrganizationSettingsCard>'s logo URL
// field is the fallback.
import { useTemplateRef } from "vue";

import { ACCEPT_ATTRIBUTE } from "../core/avatar";
import { createOrganizationLogoController } from "../core/organization-logo";
import AuthCard from "./AuthCard.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUI } from "./provider";
import { useController } from "./use-controller";

const props = defineProps<{
    /** Defaults to the active organization. */
    organizationId?: string;
}>();

const context = useAuthUI();
const t = context.localization;
// Captured at setup: the controller saves against this one organization, so a
// different id means a different card, not a new state.
const organizationId = props.organizationId;
const { actions, state } = useController((controllerContext) => createOrganizationLogoController(controllerContext, { organizationId }));
const picker = useTemplateRef<HTMLInputElement>("picker");

const onPick = (event: Event): void => {
    const file = (event.target as HTMLInputElement).files?.[0];

    // Clear the input so re-picking the same file after a failure still fires
    // `change` — browsers suppress it when the value is unchanged.
    if (picker.value !== null) {
        picker.value.value = "";
    }

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
    <AuthCard v-if="context.avatar.upload !== undefined && context.plugins.organization" :title="t.organizationLogo">
        <FormBanner :error="state.error" />
        <div class="lunora-auth-avatar-row">
            <img v-if="state.logoUrl !== undefined && state.logoUrl !== ''" class="lunora-auth-avatar" alt="" :src="state.logoUrl" />
            <span v-else class="lunora-auth-avatar lunora-auth-avatar--initials" aria-hidden="true" />
            <div class="lunora-auth-avatar-row__actions">
                <input ref="picker" class="lunora-auth-visually-hidden" type="file" :accept="ACCEPT_ATTRIBUTE" :aria-label="t.avatarUpload" @change="onPick" />
                <button class="lunora-auth-button" type="button" :disabled="state.status === 'submitting'" @click="onBrowse">{{ t.avatarUpload }}</button>
                <button
                    v-if="state.logoUrl !== undefined && state.logoUrl !== ''"
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
