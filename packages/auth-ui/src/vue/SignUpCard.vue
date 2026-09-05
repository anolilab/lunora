<script setup lang="ts">
import { computed } from "vue";

import { createSignUpController } from "../core/sign-up";
import { signInWithSocial } from "../core/social";
import AuthCard from "./AuthCard.vue";
import AuthDivider from "./AuthDivider.vue";
import AuthLink from "./AuthLink.vue";
import FormField from "./FormField.vue";
import FormBanner from "./FormBanner.vue";
import PasswordStrength from "./PasswordStrength.vue";
import { useAuthUIContextRef } from "./provider";
import SocialButtons from "./SocialButtons.vue";
import SubmitButton from "./SubmitButton.vue";
import { useController } from "./use-controller";

const props = defineProps<{
    /** Defaults to `redirects.signIn`, itself derived from `viewPaths.base`. */
    signInHref?: string;
}>();

// The context *ref*: the template unwraps it on every read, so the discovered
// provider list lands without a remount. See `provider.ts`.
const context = useAuthUIContextRef();
const t = context.value.localization;
const { actions, state } = useController(createSignUpController);

// The server can close self-serve sign-up (`emailAndPassword.disableSignUp`).
// Computed, not read at setup: `setup()` never re-runs, so a gate resolved
// here would stay frozen on the pre-discovery answer.
const signUp = computed(() => context.value.signUp);
const signInLink = computed(() => props.signInHref ?? context.value.redirects.signIn);

const onSocial = (provider: string): void => {
    void signInWithSocial(context.value, provider);
};
</script>

<template>
    <AuthCard v-if="signUp" :title="t.signUp">
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
            <FormField :actions="actions" field="name" :fields="state.fields" :label="t.nameLabel" autoComplete="name" />
            <FormField :actions="actions" field="email" :fields="state.fields" :label="t.emailLabel" type="email" autoComplete="email" />
            <FormField :actions="actions" field="password" :fields="state.fields" :label="t.passwordLabel" type="password" autoComplete="new-password" />
            <PasswordStrength :value="state.fields.password.value" /><!-- secret-scanner:allow -- a field path, not a value. -->
            <SubmitButton :pending="state.status === 'submitting'">{{ t.signUp }}</SubmitButton>
        </form>
        <template #footer>
            <AuthLink :href="signInLink">{{ t.haveAccount }}</AuthLink>
        </template>
    </AuthCard>
</template>
