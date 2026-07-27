import { createFileRoute, redirect } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { Login } from "../client/Login";
import { loadSession } from "../ssr/loader";

const LoginPage = (): ReactElement => {
    const { redirect: target } = Route.useSearch();

    return (
        <Login
            onSignedIn={() => {
                // `href` rather than `to`: the target is a runtime string, and a
                // full reload guarantees the new cookie is on the SSR request so
                // the destination renders server-side as the signed-in user.
                globalThis.location.assign(target ?? "/");
            }}
        />
    );
};

/**
 * Sign-in / sign-up. Public by design — it is the one route outside `_authed`.
 *
 * `beforeLoad` sends an already-signed-in visitor straight on, so hitting
 * `/login` with a live cookie can't strand them on a form they don't need. The
 * `redirect` search param carries the path that bounced them here.
 */
export const Route = createFileRoute("/login")({
    validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
        return {
            // Only ever accept a same-site absolute path — an attacker-supplied
            // `?redirect=https://evil.example` must not become an open redirect after
            // a successful sign-in.
            redirect: typeof search.redirect === "string" && search.redirect.startsWith("/") && !search.redirect.startsWith("//") ? search.redirect : undefined,
        };
    },
    component: LoginPage,
    beforeLoad: async ({ search }) => {
        if (await loadSession()) {
            throw redirect({ to: search.redirect ?? "/" });
        }
    },
});
