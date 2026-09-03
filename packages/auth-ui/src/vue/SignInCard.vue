<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { LAST_METHOD_EMAIL, readLastLoginMethod } from "../core/last-login-method";
import { createSignInController } from "../core/sign-in";
import { signInWithSocial } from "../core/social";
import AnonymousButton from "./AnonymousButton.vue";
import AuthCard from "./AuthCard.vue";
import AuthDivider from "./AuthDivider.vue";
import AuthLink from "./AuthLink.vue";
import FormField from "./FormField.vue";
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
// Read after mount, not at setup: the server has no cookie, so a render-time
// read is a hydration mismatch. See `lastLoginMethodStore`.
const lastUsedAfterMount = ref<string | undefined>();

onMounted(() => {
    lastUsedAfterMount.value = readLastLoginMethod();
});

const lastUsed = computed(() => (context.value.plugins.lastLoginMethod ? lastUsedAfterMount.value : undefined));

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
        <SocialButtons :providers="context.social" :lastUsed="lastUsed" @select="onSocial" />
        <AnonymousButton v-if="context.plugins.anonymous" />
        <AuthDivider v-if="context.social.length > 0 && context.credentials" />
        <!--
            An OAuth-only deployment has no password form to show. Discovery
            reports that as `emailAndPassword: false`; without discovery it
            defaults to true, which is the pre-existing behaviour.
        -->
        <form v-if="context.credentials" class="lunora-auth-form" novalidate @submit.prevent="actions.submit">
            <FormBanner :error="state.formError" />
            <FormField :actions="actions" field="email" :fields="state.fields" :label="t.emailLabel" type="email" autoComplete="email" />
            <FormField :actions="actions" field="password" :fields="state.fields" :label="t.passwordLabel" type="password" autoComplete="current-password" />
            <AuthLink :href="forgotPasswordHref">{{ t.forgotPasswordLink }}</AuthLink>
            <SubmitButton :pending="state.status === 'submitting'">
                {{ t.signIn }}
                <!-- better-auth records a password sign-in as "email", so without this the badge is invisible for the most common route there is. -->
                <span v-if="lastUsed === LAST_METHOD_EMAIL" class="lunora-auth-social__badge">{{ t.lastUsed }}</span>
            </SubmitButton>
        </form>
        <template v-if="context.signUp" #footer>
            <AuthLink :href="signUpHref">{{ t.noAccount }}</AuthLink>
        </template>
    </AuthCard>
</template>
