<script setup lang="ts">
import { createProfileController } from "../core/profile";
import AuthCard from "./AuthCard.vue";
import FormField from "./FormField.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUI } from "./provider";
import SubmitButton from "./SubmitButton.vue";
import { useController } from "./use-controller";

const props = defineProps<{
    defaultImage?: string;
    defaultName?: string;
}>();

const { localization: t } = useAuthUI();
const { actions, state } = useController((context) => createProfileController(context, { initialImage: props.defaultImage, initialName: props.defaultName }));
</script>

<template>
    <AuthCard :headingLevel="2" :title="t.profile">
        <form class="lunora-auth-form" novalidate @submit.prevent="actions.submit">
            <FormBanner :error="state.formError" :success="state.successMessage" />
            <FormField :actions="actions" field="name" :fields="state.fields" :label="t.nameLabel" autoComplete="name" />
            <SubmitButton :pending="state.status === 'submitting'">{{ t.saveChanges }}</SubmitButton>
        </form>
    </AuthCard>
</template>
