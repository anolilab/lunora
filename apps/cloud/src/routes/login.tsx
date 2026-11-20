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
    const { invited, redirect: target } = Route.useSearch();

    return (
        <Login
            invited={invited}
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
 *
 * `invited` is derived from `?invite=`, not read as its own parameter: the token
 * itself belongs to the sign-up form (which reads it off the URL at submit time
 * and never renders it), and all this route needs to know is that one is present
 * so it opens on sign-up rather than sign-in. Through `validateSearch` rather
 * than `location.search` so the server and the client agree — reading the URL in
 * the component would render sign-in on the server and sign-up on the client.
 */
export const Route = createFileRoute("/login")({
    validateSearch: (search: Record<string, unknown>): { invited?: boolean; redirect?: string } => {
        const invited = typeof search.invite === "string" && search.invite !== "";

        // Only when true: an `invited: false` in the type would make every other
        // `redirect({ to: "/login" })` in the app have to say so.
        return { ...(invited ? { invited } : {}), redirect: safeRedirect(search.redirect) };
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
