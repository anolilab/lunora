<script setup lang="ts">
import { createSignUpController } from "../core";
import AuthCard from "./AuthCard.vue";
import AuthLink from "./AuthLink.vue";
import Field from "./Field.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUI } from "./provider";
import SubmitButton from "./SubmitButton.vue";
import { useController } from "./use-controller";

withDefaults(
    defineProps<{
        signInHref?: string;
    }>(),
    {
        signInHref: "/sign-in",
    },
);

const { localization: t } = useAuthUI();
const { actions, state } = useController(createSignUpController);
</script>

<template>
    <AuthCard :title="t.signUp">
        <form class="lunora-auth-form" novalidate @submit.prevent="actions.submit">
            <FormBanner :error="state.formError" />
            <Field
                :field="state.fields.name"
                :label="t.nameLabel"
                name="name"
                autoComplete="name"
                @blur="actions.blur('name')"
                @change="actions.setField('name', $event)"
            />
            <Field
                :field="state.fields.email"
                :label="t.emailLabel"
                name="email"
                type="email"
                autoComplete="email"
                @blur="actions.blur('email')"
                @change="actions.setField('email', $event)"
            />
            <Field
                :field="state.fields.password"
                :label="t.passwordLabel"
                name="password"
                type="password"
                autoComplete="new-password"
                @blur="actions.blur('password')"
                @change="actions.setField('password', $event)"
            />
            <SubmitButton :pending="state.status === 'submitting'">{{ t.signUp }}</SubmitButton>
        </form>
        <template #footer>
            <AuthLink :href="signInHref">{{ t.haveAccount }}</AuthLink>
        </template>
    </AuthCard>
</template>
