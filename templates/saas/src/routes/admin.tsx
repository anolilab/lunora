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
    const rows = useQuery(api.saas.listOrganizations, {});
    const [now] = useState(() => Date.now());

    return (
        <main style={{ margin: "2rem auto", maxWidth: "56rem", padding: "0 1rem" }}>
            <AdminOrganizations now={now} rows={rows} />
        </main>
    );
}
