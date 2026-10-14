"use client";

import type { ReactNode } from "react";

import { useAuthState } from "./auth-state";

interface AuthGateProps {
    children: ReactNode;
}

/**
 * Renders `children` once authentication has settled in the caller's favour — a
 * credential is held and nothing has contradicted it. Follows the shared
 * `AuthStatus` contract in `@lunora/client/auth`, so an unreachable identity
 * endpoint keeps the gate open (with `useAuth().user` still `null`).
 */
const Authenticated = ({ children }: AuthGateProps): ReactNode => {
    const { isAuthenticated } = useAuthState();

    return isAuthenticated ? children : undefined;
};

/** Renders `children` only when auth has settled and there is no session. */
const Unauthenticated = ({ children }: AuthGateProps): ReactNode => {
    const { isAuthenticated, isLoading } = useAuthState();

    return !isLoading && !isAuthenticated ? children : undefined;
};

/** Renders `children` while auth is still settling — before hydration, or while the first identity resolve is in flight. */
const AuthLoading = ({ children }: AuthGateProps): ReactNode => {
    const { isLoading } = useAuthState();

    return isLoading ? children : undefined;
};

export { Authenticated, AuthLoading, Unauthenticated };
