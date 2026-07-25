<script setup lang="ts">
import { createMagicLinkController, isFlowEnabled } from "../core";
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

const context = useAuthUI();
const t = context.localization;
const enabled = isFlowEnabled(context, "magicLink", "MagicLinkCard");
const { actions, state } = useController(createMagicLinkController);
</script>

<template>
    <AuthCard v-if="enabled" :title="t.magicLink">
        <form class="lunora-auth-form" novalidate @submit.prevent="actions.submit">
            <FormBanner :error="state.formError" :success="state.successMessage" />
            <Field
                :field="state.fields.email"
                :label="t.emailLabel"
                name="email"
                type="email"
                autoComplete="email"
                @blur="actions.blur('email')"
                @change="actions.setField('email', $event)"
            />
            <SubmitButton :pending="state.status === 'submitting'">{{ t.magicLink }}</SubmitButton>
        </form>
        <template #footer>
            <AuthLink :href="signInHref">{{ t.backToSignIn }}</AuthLink>
        </template>
    </AuthCard>
</template>
