<script setup lang="ts">
import { createSignUpController } from "../core/sign-up";
import { signInWithSocial } from "../core/social";
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
        signInHref?: string;
    }>(),
    {
        signInHref: "/sign-in",
    },
);

const context = useAuthUI();
const t = context.localization;
const { actions, state } = useController(createSignUpController);

const onSocial = (provider: string): void => {
    void signInWithSocial(context, provider);
};
</script>

<template>
    <AuthCard :title="t.signUp">
        <!--
            Social buttons belong on sign-up too — OAuth is a sign-up path, not
            just a sign-in one, and omitting them here sends new users through a
            password form they never needed. This was the gap against
            better-auth-ui's <AuthView>.
        -->
        <SocialButtons :providers="context.social" @select="onSocial" />
        <AuthDivider v-if="context.social.length > 0" />
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
