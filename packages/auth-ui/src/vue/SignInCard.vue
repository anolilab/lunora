<script setup lang="ts">
import { readLastLoginMethod } from "../core/last-login-method";
import { createSignInController } from "../core/sign-in";
import { signInWithSocial } from "../core/social";
import AnonymousButton from "./AnonymousButton.vue";
import AuthCard from "./AuthCard.vue";
import AuthDivider from "./AuthDivider.vue";
import AuthLink from "./AuthLink.vue";
import Field from "./Field.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUIContextRef } from "./provider";
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

const context = useAuthUIContextRef();
const t = context.value.localization;
const { actions, state } = useController(createSignInController);
// Read once at setup rather than from a watcher: it is a cookie, it is there
// before the first paint, and it only picks a badge.
const lastUsed = readLastLoginMethod();

const onSocial = (provider: string): void => {
    void signInWithSocial(context.value, provider);
};
</script>

<template>
    <!--
        `context` is the context *ref*, which the template unwraps on every read
        — so the provider list and the password gate re-evaluate when server
        discovery answers, rather than being frozen at the value `setup()` saw.
    -->
    <AuthCard :title="t.signIn">
        <SocialButtons :providers="context.social" :lastUsed="context.plugins.lastLoginMethod ? lastUsed : undefined" @select="onSocial" />
        <AnonymousButton v-if="context.plugins.anonymous" />
        <AuthDivider v-if="context.social.length > 0 && context.credentials" />
        <!--
            An OAuth-only deployment has no password form to show. Discovery
            reports that as `emailAndPassword: false`; without discovery it
            defaults to true, which is the pre-existing behaviour.
        -->
        <form v-if="context.credentials" class="lunora-auth-form" novalidate @submit.prevent="actions.submit">
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
        <template v-if="context.signUp" #footer>
            <AuthLink :href="signUpHref">{{ t.noAccount }}</AuthLink>
        </template>
    </AuthCard>
</template>
