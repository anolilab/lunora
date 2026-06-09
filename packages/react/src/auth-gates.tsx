"use client";

import type { ReactNode } from "react";

import { useAuthState } from "./auth-state";

interface AuthGateProps {
    children: ReactNode;
}

/** Renders `children` only once a token is set on the client (after hydration). */
const Authenticated = ({ children }: AuthGateProps): ReactNode => {
    const { isAuthenticated } = useAuthState();

    return isAuthenticated ? children : undefined;
};

/** Renders `children` only when auth has settled and no token is set. */
const Unauthenticated = ({ children }: AuthGateProps): ReactNode => {
    const { isAuthenticated, isLoading } = useAuthState();

    return !isLoading && !isAuthenticated ? children : undefined;
};

/** Renders `children` while auth is still settling (before hydration completes). */
const AuthLoading = ({ children }: AuthGateProps): ReactNode => {
    const { isLoading } = useAuthState();

    return isLoading ? children : undefined;
};

export { Authenticated, AuthLoading, Unauthenticated };
