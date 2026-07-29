<script setup lang="ts">
// The avatar menu: who is signed in, plus sign-out and whatever the app hangs
// off it (passed as the default slot — links, an organization switcher, …).
//
// It is a disclosure rather than a `<menu>` because its contents are app-defined
// and forcing those into menu item semantics would mislabel them. Escape and
// outside-click close it, and focus returns to the trigger, which is the part
// hand-rolled dropdowns usually miss.
import { onScopeDispose, ref, useId, useTemplateRef, watch } from "vue";

import { createSessionController, userLabel } from "../core/session";
import { signOut } from "../core/session-actions";
import { useAuthUI } from "./provider";
import { useController } from "./use-controller";
import UserAvatar from "./UserAvatar.vue";
import UserView from "./UserView.vue";

defineProps<{
    /** Render nothing at all when signed out, instead of a sign-in link. */
    hideWhenSignedOut?: boolean;
}>();

const context = useAuthUI();
const t = context.localization;
const { actions, state } = useController(createSessionController);

const open = ref(false);
const root = useTemplateRef<HTMLDivElement>("root");
const trigger = useTemplateRef<HTMLButtonElement>("trigger");
// Generated, not hard-coded: two menus on one page must not collide.
const menuId = useId();

const close = (): void => {
    open.value = false;
    trigger.value?.focus();
};

const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
        close();
    }
};

const onPointerDown = (event: MouseEvent): void => {
    if (root.value && !root.value.contains(event.target as Node)) {
        // Not `close()`: a click elsewhere is the user moving on, and yanking
        // focus back to the trigger would fight them for it.
        open.value = false;
    }
};

const detach = (): void => {
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("mousedown", onPointerDown);
};

// Document listeners only exist while the menu is open, so a page full of these
// doesn't accumulate handlers for menus nobody has touched.
watch(open, (value) => {
    if (value) {
        document.addEventListener("keydown", onKeyDown);
        document.addEventListener("mousedown", onPointerDown);
    } else {
        detach();
    }
});

onScopeDispose(detach);

const onToggle = (): void => {
    open.value = !open.value;
};

const onSignOut = (): void => {
    open.value = false;
    void signOut(context).then(actions.refetch);
};
</script>

<template>
    <!--
        "Not asked yet" and "asked, nobody home" look identical in `user`, and
        rendering a sign-in link during the first request makes every page flash
        one. `settled` is the difference.
    -->
    <span v-if="!state.settled" class="lunora-auth-userbutton lunora-auth-userbutton--loading" />
    <a v-else-if="state.user === undefined && hideWhenSignedOut !== true" class="lunora-auth-link" :href="context.redirects.signIn">{{ t.signIn }}</a>
    <div v-else-if="state.user !== undefined" ref="root" class="lunora-auth-userbutton">
        <button
            ref="trigger"
            class="lunora-auth-userbutton__trigger"
            type="button"
            aria-haspopup="true"
            :aria-controls="open ? menuId : undefined"
            :aria-expanded="open"
            :aria-label="userLabel(state.user)"
            @click="onToggle"
        >
            <UserAvatar :user="state.user" />
        </button>
        <div v-if="open" :id="menuId" class="lunora-auth-userbutton__menu">
            <div class="lunora-auth-userbutton__header">
                <UserView :user="state.user" />
            </div>
            <slot />
            <button class="lunora-auth-button lunora-auth-button--secondary" type="button" @click="onSignOut">{{ t.signOut }}</button>
        </div>
    </div>
</template>
