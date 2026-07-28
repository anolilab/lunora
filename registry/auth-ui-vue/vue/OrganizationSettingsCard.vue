<script setup lang="ts">
import { isFlowEnabled } from "../core/flow-gate";
import { createOrganizationSettingsController } from "../core/organization-settings";
import AuthCard from "./AuthCard.vue";
import Field from "./Field.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUI } from "./provider";
import SubmitButton from "./SubmitButton.vue";
import { useController } from "./use-controller";

const props = defineProps<{
    /** Defaults to the user's active organization. */
    organizationId?: string;
}>();

const context = useAuthUI();
const t = context.localization;
const enabled = isFlowEnabled(context, "organization", "OrganizationSettingsCard");
const { actions, state } = useController((context_) =>
    createOrganizationSettingsController(context_, { autoLoad: enabled, organizationId: props.organizationId }),
);
</script>

<template>
    <AuthCard v-if="enabled" :title="t.organizationSettings">
        <p v-if="state.loading" class="lunora-auth-card__description">…</p>
        <form v-else class="lunora-auth-form" novalidate @submit.prevent="actions.submit">
            <FormBanner :error="state.formError" :success="state.successMessage" />
            <Field
                :field="state.fields.name"
                :label="t.organizationName"
                name="organizationName"
                @blur="actions.blur('name')"
                @change="actions.setField('name', $event)"
            />
            <Field
                :field="state.fields.slug"
                :label="t.organizationSlug"
                name="organizationSlug"
                @blur="actions.blur('slug')"
                @change="actions.setField('slug', $event)"
            />
            <Field
                :field="state.fields.logo"
                :label="t.organizationLogo"
                name="organizationLogo"
                @blur="actions.blur('logo')"
                @change="actions.setField('logo', $event)"
            />
            <SubmitButton :pending="state.status === 'submitting'">{{ t.saveChanges }}</SubmitButton>
        </form>
    </AuthCard>
</template>
