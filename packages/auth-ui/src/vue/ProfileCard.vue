<script setup lang="ts">
import { createProfileController } from "../core/profile";
import AuthCard from "./AuthCard.vue";
import Field from "./Field.vue";
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
    <AuthCard :title="t.profile">
        <form class="lunora-auth-form" novalidate @submit.prevent="actions.submit">
            <FormBanner :error="state.formError" :success="state.successMessage" />
            <Field
                :field="state.fields.name"
                :label="t.nameLabel"
                name="name"
                autoComplete="name"
                @blur="actions.blur('name')"
                @change="actions.setField('name', $event)"
            />
            <SubmitButton :pending="state.status === 'submitting'">{{ t.saveChanges }}</SubmitButton>
        </form>
    </AuthCard>
</template>
