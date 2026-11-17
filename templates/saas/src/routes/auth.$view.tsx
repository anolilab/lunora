import { createFileRoute } from "@tanstack/react-router";

import "../../lunora/saas-ui/styles.css";

export const Route = createFileRoute("/auth/$view")({
    component: AuthPlaceholder,
});

/**
 * Stands in for the auth screens until `lunora add auth-ui` copies them in. The
 * landing page links here, and without a route a visitor's first click would be
 * a 404. Replace this file with the snippet in the README once the screens exist:
 * it imports `lunora/auth-ui/*`, which this template cannot ship, so the real
 * route cannot be here from the start.
 */
function AuthPlaceholder() {
    return (
        <main className="lu-saas-card" style={{ margin: "3rem auto", maxWidth: "44rem" }}>
            <h1>Sign-in is not set up yet</h1>
            <p>
                Run <code>pnpm exec lunora add auth-ui</code>, then replace <code>src/routes/auth.$view.tsx</code> with the route in the README.
            </p>
        </main>
    );
}
