<script setup lang="ts">
import { createSignInController, signInWithSocial } from "../core";
import AuthCard from "./AuthCard.vue";
import AuthDivider from "./AuthDivider.vue";
import AuthLink from "./AuthLink.vue";
import Field from "./Field.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUI } from "./provider";
import SocialButtons from "./SocialButtons.vue";
import SubmitButton from "./SubmitButton.vue";
import { useController } from "./use-controller";

withDefaults(
    defineProps<{
        forgotPasswordHref?: string;
        signUpHref?: string;
    }>(),
    {
        forgotPasswordHref: "/forgot-password",
        signUpHref: "/sign-up",
    },
);

const context = useAuthUI();
const t = context.localization;
const social = context.social;
const { actions, state } = useController(createSignInController);

const onSocial = (provider: string): void => {
    void signInWithSocial(context, provider);
};
</script>

<template>
    <AuthCard :title="t.signIn">
        <SocialButtons :providers="social" @select="onSocial" />
        <AuthDivider v-if="social.length > 0" />
        <form class="lunora-auth-form" novalidate @submit.prevent="actions.submit">
            <FormBanner :error="state.formError" />
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
                autoComplete="current-password"
                @blur="actions.blur('password')"
                @change="actions.setField('password', $event)"
            />
            <AuthLink :href="forgotPasswordHref">{{ t.forgotPasswordLink }}</AuthLink>
            <SubmitButton :pending="state.status === 'submitting'">{{ t.signIn }}</SubmitButton>
        </form>
        <template #footer>
            <AuthLink :href="signUpHref">{{ t.noAccount }}</AuthLink>
        </template>
    </AuthCard>
</template>
