<script setup lang="ts">
import { signOut } from "../core/session-actions";
import { useAuthUI } from "./provider";

const props = defineProps<{
    label?: string;
}>();

const context = useAuthUI();
const themeStyle = Object.keys(context.themeVariables).length === 0 ? undefined : context.themeVariables;

const onSignOut = (): void => {
    void signOut(context);
};
</script>

<template>
    <button class="lunora-auth-button lunora-auth-button--secondary" type="button" :style="themeStyle" @click="onSignOut">
        {{ props.label ?? context.localization.signOut }}
    </button>
</template>
