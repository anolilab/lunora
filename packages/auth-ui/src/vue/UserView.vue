<script setup lang="ts">
// Avatar + name + email, the block that identifies an account in a list or menu.
import type { AuthUser } from "../core/types";
import { userLabel } from "../core/session";
import UserAvatar from "./UserAvatar.vue";

defineProps<{
    /** Hide the email line, for tight rows. */
    compact?: boolean;
    user?: AuthUser;
}>();
</script>

<template>
    <span class="lunora-auth-user">
        <UserAvatar :size="compact === true ? 24 : 36" :user="user" />
        <span class="lunora-auth-user__text">
            <span class="lunora-auth-user__name">{{ userLabel(user) }}</span>
            <span v-if="compact !== true && user?.email !== undefined" class="lunora-auth-user__email">{{ user?.email }}</span>
        </span>
    </span>
</template>
