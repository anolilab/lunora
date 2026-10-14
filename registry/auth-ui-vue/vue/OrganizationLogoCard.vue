<script setup lang="ts">
// Upload an organization's logo. Rendered only when the app configured an
// `avatar.upload` handler — without one, <OrganizationSettingsCard>'s logo URL
// field is the fallback.
import { useId } from "vue";

import { ACCEPT_ATTRIBUTE } from "../core/avatar";
import { createOrganizationLogoController } from "../core/organization-logo";
import AuthCard from "./AuthCard.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUIContextRef } from "./provider";
import { useController } from "./use-controller";

const props = defineProps<{
    /** Defaults to the active organization. */
    organizationId?: string;
}>();

// The context *ref*, so the template's gate follows a discovered `organization`
// flag rather than freezing on the value `setup()` saw. See `provider.ts`.
const context = useAuthUIContextRef();
const t = context.value.localization;
// Captured at setup: the controller saves against this one organization, so a
// different id means a different card, not a new state.
const organizationId = props.organizationId;
const { actions, state } = useController((controllerContext) => createOrganizationLogoController(controllerContext, { organizationId }));
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
    <AuthCard v-if="context.avatar.upload !== undefined && context.plugins.organization" :title="t.organizationLogo">
        <FormBanner :error="state.error" />
        <div class="lunora-auth-avatar-row">
            <img v-if="state.logoUrl !== undefined && state.logoUrl !== ''" class="lunora-auth-avatar" alt="" :src="state.logoUrl" />
            <span v-else class="lunora-auth-avatar lunora-auth-avatar--initials" aria-hidden="true" />
            <div class="lunora-auth-avatar-row__actions">
                <!-- A label wrapping the input — see AvatarCard.vue. -->
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
