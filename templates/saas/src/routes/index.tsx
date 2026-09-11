import { createFileRoute, Link } from "@tanstack/react-router";

import "../../lunora/saas-ui/styles.css";

export const Route = createFileRoute("/")({
    component: MarketingPage,
});

/**
 * The marketing home. Deliberately plain — this is the page you replace first,
 * and every line of it is easier to delete than to untangle from a layout
 * system you did not choose.
 */
function MarketingPage() {
    return (
        <main className="lu-saas-card" style={{ margin: "3rem auto", maxWidth: "44rem" }}>
            <h1 style={{ fontSize: "2rem", marginTop: 0 }}>{"{{name}}"}</h1>
            <p>
                A multi-tenant SaaS on Lunora: organizations, projects, an activity feed and an admin view — every query live, so a change in one tab lands in
                the others without a reload.
            </p>
            <ul className="lu-saas-list">
                <li className="lu-saas-row">
                    <span className="lu-saas-row__name">Free</span>
                    <span>1 organization, 3 projects</span>
                </li>
                <li className="lu-saas-row">
                    <span className="lu-saas-row__name">Pro</span>
                    <span>Unlimited projects, 10 seats</span>
                </li>
            </ul>
            <p style={{ display: "flex", gap: "0.5rem" }}>
                <Link className="lu-saas-button" to="/dashboard">
                    Open the dashboard
                </Link>
                <a className="lu-saas-button lu-saas-button--quiet" href="/api/auth/sign-in">
                    Sign in
                </a>
            </p>
        </main>
    );
}
