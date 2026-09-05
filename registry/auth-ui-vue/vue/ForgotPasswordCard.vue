<script setup lang="ts">
import { computed } from "vue";
import { createForgotPasswordController } from "../core/forgot-password";
import AuthCard from "./AuthCard.vue";
import AuthLink from "./AuthLink.vue";
import FormField from "./FormField.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUI } from "./provider";
import SubmitButton from "./SubmitButton.vue";
import { useController } from "./use-controller";

const props = defineProps<{
    /** Defaults to the configured reset-password route; see `viewPaths.base`. */
    resetPath?: string;
    /** Defaults to `redirects.signIn`, itself derived from `viewPaths.base`. */
    signInHref?: string;
}>();

const { localization: t, redirects } = useAuthUI();
const signInLink = computed(() => props.signInHref ?? redirects.signIn);
const { actions, state } = useController((context) => createForgotPasswordController(context, { resetPath: props.resetPath }));
</script>

<template>
    <AuthCard :title="t.forgotPassword">
        <form class="lunora-auth-form" novalidate @submit.prevent="actions.submit">
            <FormBanner :error="state.formError" :success="state.successMessage" />
            <FormField :actions="actions" field="email" :fields="state.fields" :label="t.emailLabel" type="email" autoComplete="email" />
            <SubmitButton :pending="state.status === 'submitting'">{{ t.forgotPassword }}</SubmitButton>
        </form>
        <template #footer>
            <AuthLink :href="signInLink">{{ t.backToSignIn }}</AuthLink>
        </template>
    </AuthCard>
</template>
