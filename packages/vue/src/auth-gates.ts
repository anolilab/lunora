import { isAuthenticatedStatus, isLoadingStatus } from "@lunora/client/auth";
import type { Component } from "vue";
import { computed, defineComponent } from "vue";

import { useAuth } from "./use-auth";

/**
 * Render the default slot once authentication has settled in the caller's
 * favour — a credential is held and nothing has contradicted it.
 *
 * Gated on {@link isAuthenticatedStatus}, the shared contract in
 * `@lunora/client/auth`, not on `user !== null`: an unreachable identity
 * endpoint leaves `user` at `null` while the credential is still perfectly
 * valid, and requiring a user record there hid the whole app behind
 * `AuthLoading` for the length of an offline session.
 */
const Authenticated: Component = defineComponent({
    name: "Authenticated",
    setup(_props, { slots }) {
        const { status } = useAuth();
        const isAuthenticated = computed(() => isAuthenticatedStatus(status.value));

        return () => (isAuthenticated.value ? slots.default?.() : undefined);
    },
});

/**
 * Render the default slot only when authentication has settled and there is no
 * session — no credential, or the server answered that the credential has none.
 */
const Unauthenticated: Component = defineComponent({
    name: "Unauthenticated",
    setup(_props, { slots }) {
        const { status } = useAuth();
        const isSignedOut = computed(() => status.value === "unauthenticated");

        return () => (isSignedOut.value ? slots.default?.() : undefined);
    },
});

/**
 * Render the default slot while authentication is still in progress — a
 * credential is held and the first identity resolve has not come back yet.
 */
const AuthLoading: Component = defineComponent({
    name: "AuthLoading",
    setup(_props, { slots }) {
        const { status } = useAuth();
        const isLoading = computed(() => isLoadingStatus(status.value));

        return () => (isLoading.value ? slots.default?.() : undefined);
    },
});

export { Authenticated, AuthLoading, Unauthenticated };
