import type { Component } from "vue";
import { computed, defineComponent } from "vue";

import { useAuth } from "./use-auth";

/**
 * Render the default slot only after auth has settled and a token + user are
 * both present. Hides the slot on first render and when signed out.
 */
const Authenticated: Component = defineComponent({
    name: "Authenticated",
    setup(_props, { slots }) {
        const { token, user } = useAuth();
        const isAuthenticated = computed(() => token.value !== null && user.value !== null);

        return () => (isAuthenticated.value ? slots.default?.() : undefined);
    },
});

/**
 * Render the default slot only when auth has settled and no token is present
 * (the signed-out state). Hidden while the user is still loading.
 */
const Unauthenticated: Component = defineComponent({
    name: "Unauthenticated",
    setup(_props, { slots }) {
        const { token, user } = useAuth();
        const isLoading = computed(() => token.value !== null && user.value === null);

        return () => (!isLoading.value && token.value === null ? slots.default?.() : undefined);
    },
});

/**
 * Render the default slot while authentication is still in progress — token is
 * set but `getCurrentUser()` has not yet resolved.
 */
const AuthLoading: Component = defineComponent({
    name: "AuthLoading",
    setup(_props, { slots }) {
        const { token, user } = useAuth();
        const isLoading = computed(() => token.value !== null && user.value === null);

        return () => (isLoading.value ? slots.default?.() : undefined);
    },
});

export { Authenticated, AuthLoading, Unauthenticated };
