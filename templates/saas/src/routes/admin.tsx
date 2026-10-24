import type { SubscriptionError } from "@lunora/react";
import { useQuery } from "@lunora/react";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { api } from "../../lunora/_generated/api";
import { AdminOrganizations } from "../../lunora/saas-ui/react";

import "../../lunora/saas-ui/styles.css";

export const Route = createFileRoute("/admin")({
    component: AdminPage,
});

/**
 * The platform admin view. It reads the `.global()` `saas_organizations`
 * projection — the one cross-tenant read the shard model allows — and the query
 * itself refuses anyone without the platform admin role, so this route needs no
 * gate of its own beyond not linking to it from the app nav.
 *
 * Rows arrive as organisations are created: better-auth's organization hooks
 * project each one (`lunora/auth/index.ts`).
 */
function AdminPage() {
    // A query the server refuses never resolves, so `rows` would stay `undefined`
    // and the list would load forever. The refusal arrives here instead.
    const [failure, setFailure] = useState<SubscriptionError>();
    const rows = useQuery(api.saas.listOrganizations, {}, { onError: setFailure });
    const [now] = useState(() => Date.now());

    if (failure) {
        return (
            <main className="lu-saas-card" style={{ margin: "3rem auto", maxWidth: "44rem" }}>
                <p role="alert">
                    {failure.code === "FORBIDDEN" || failure.code === "UNAUTHORIZED"
                        ? "This page is for platform admins."
                        : "Could not load organizations — try again."}
                </p>
            </main>
        );
    }

    return (
        <main style={{ margin: "2rem auto", maxWidth: "56rem", padding: "0 1rem" }}>
            <AdminOrganizations now={now} rows={rows} />
        </main>
    );
}
