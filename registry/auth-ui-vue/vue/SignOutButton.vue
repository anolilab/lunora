<script setup lang="ts">
import { signOut } from "../core";
import { useAuthUI } from "./provider";

const props = defineProps<{
    label?: string;
}>();

const context = useAuthUI();

const onSignOut = (): void => {
    void signOut(context);
};
</script>

<template>
    <button class="lunora-auth-button lunora-auth-button--secondary" type="button" @click="onSignOut">
        {{ props.label ?? context.localization.signOut }}
    </button>
</template>
