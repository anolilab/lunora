import { createFileRoute, redirect } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { Login } from "../client/Login";
import { loadSession } from "../ssr/loader";

/**
 * Reduce a caller-supplied `?redirect=` to a safe same-origin path, or `undefined`.
 *
 * Validated *positively* — resolve it, then require the result to be this origin —
 * rather than by rejecting shapes that look absolute. The obvious blocklist
 * (accept a leading `/`, reject a leading `//`) is not enough: WHATWG URL treats `\` as a
 * path separator for special schemes and strips C0 control characters, so
 * `/\evil.example`, `/\/evil.example` and `/&lt;TAB>/evil.example` all satisfy it and
 * then resolve to `https://evil.example/`. Both sinks are reachable — the
 * `location.assign` after sign-in, and the `beforeLoad` redirect below, which fires
 * with no interaction at all for an already-signed-in visitor. Phishing that begins
 * on the genuine control-plane domain is the payoff.
 *
 * Only `pathname + search + hash` is returned, so no part of an attacker's URL
 * (scheme, host, credentials) survives even when resolution succeeds.
 */
const safeRedirect = (candidate: unknown): string | undefined => {
    if (typeof candidate !== "string" || candidate === "") {
        return undefined;
    }

    // A fixed opaque base: only the origin *comparison* matters, and a constant makes
    // the check identical on the server (where there is no `location`) and client.
    const base = "https://lunora.invalid";

    try {
        const resolved = new URL(candidate, base);

        if (resolved.origin !== base) {
            return undefined;
        }

        return `${resolved.pathname}${resolved.search}${resolved.hash}`;
    } catch {
        return undefined;
    }
};

const LoginPage = (): ReactElement => {
    const { redirect: target } = Route.useSearch();

    return (
        <Login
            onSignedIn={() => {
                // A full load rather than a client navigation: it guarantees the new
                // cookie is on the SSR request, so the destination renders
                // server-side as the signed-in user. `target` has already been reduced
                // to a same-origin path by `safeRedirect`.
                globalThis.location.assign(target ?? "/");
            }}
        />
    );
};

/**
 * Sign-in / sign-up. Public by design — it is the one route outside `_authed`.
 *
 * `beforeLoad` sends an already-signed-in visitor straight on, so hitting `/login`
 * with a live cookie can't strand them on a form they don't need. The `redirect`
 * search param carries the path that bounced them here.
 */
export const Route = createFileRoute("/login")({
    validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
        return { redirect: safeRedirect(search.redirect) };
    },
    component: LoginPage,
    beforeLoad: async ({ search }) => {
        if (await loadSession()) {
            // `href`, not `to`: the target is a runtime string, not one of the
            // router's known literal route paths.
            throw redirect({ href: search.redirect ?? "/" });
        }
    },
});
