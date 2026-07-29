<script setup lang="ts">
// The page the verification link lands on. It consumes the token on mount and
// redirects, so the only states a user sees are "working" and "that link is no
// longer good".
import { queryParameter } from "../core/browser-location";
import { createVerifyEmailController } from "../core/verify-email";
import AuthCard from "./AuthCard.vue";
import FormBanner from "./FormBanner.vue";
import { useAuthUI } from "./provider";
import { useController } from "./use-controller";

const props = defineProps<{
    /** Defaults to `?token=` from the URL. */
    token?: string;
}>();

const { localization: t } = useAuthUI();
// Captured at setup: the controller consumes the token once on creation, so a
// token that changes afterwards means a new card, not a new state.
const token = props.token ?? queryParameter("token");
const { actions, state } = useController((context) => createVerifyEmailController(context, { token }));

const onResend = (): void => {
    void actions.verify();
};
</script>

<template>
    <AuthCard :title="t.verifyEmail">
        <FormBanner :error="state.error" />
        <p v-if="state.status === 'submitting' || state.status === 'idle'" class="lunora-auth-note">{{ t.verifyEmailVerifying }}</p>
        <button v-if="state.status === 'error'" class="lunora-auth-button lunora-auth-button--secondary" type="button" @click="onResend">
            {{ t.verifyEmailResend }}
        </button>
    </AuthCard>
</template>
