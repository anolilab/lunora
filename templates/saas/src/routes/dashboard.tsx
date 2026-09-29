import { useMutation, usePresence, useQuery } from "@lunora/react";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { api } from "../../lunora/_generated/api";
import type { Id } from "../../lunora/_generated/dataModel";
import { ActivityFeed, OverviewStats, PresenceBar, ProjectsCard } from "../../lunora/saas-ui/react";

import "../../lunora/saas-ui/styles.css";

export const Route = createFileRoute("/dashboard")({
    component: DashboardPage,
});

/** Roles the server lets create and archive projects (`WRITER_ROLES` in `lunora/saas/index.ts`). */
const WRITER_ROLES = new Set(["admin", "owner"]);

/**
 * Who the caller is and which organisation they are in — read on the root
 * shard, because the organisation id is what every other call here needs to
 * know where to go.
 */
function DashboardPage() {
    // `authorizeShard` turns an anonymous caller away from every shard, the root
    // included, so a signed-out visitor sees this subscription fail rather than
    // resolve to `null`.
    const [signedOut, setSignedOut] = useState(false);
    const me = useQuery(api.saas.me, {}, { onError: () => setSignedOut(true) });

    if (me === undefined && !signedOut) {
        return <main aria-busy="true" style={{ margin: "2rem auto", maxWidth: "56rem", padding: "0 1rem" }} />;
    }

    if (!me?.organizationId) {
        return (
            <main className="lu-saas-card" style={{ margin: "3rem auto", maxWidth: "44rem" }}>
                <p>{me ? "Create or switch to an organization to see its dashboard." : "Sign in to see your dashboard."}</p>
            </main>
        );
    }

    return <OrganizationDashboard name={me.name} organizationId={me.organizationId} orgRole={me.orgRole} userId={me.userId} />;
}

interface OrganizationDashboardProps {
    name: string | undefined;
    organizationId: string;
    orgRole: string | undefined;
    userId: string;
}

/**
 * The dashboard. This component owns the subscriptions and the mutations; the
 * cards own the pixels — which is why they take rows as props and never call
 * `useQuery` themselves.
 *
 * Every call carries `shardKey: organizationId`: the tenant's rows live in its
 * own Durable Object, and the Worker's `authorizeShard` admits the caller to
 * that one only. One `api.saas.overview` subscription feeds both cards — two
 * queries would be two subscriptions over the same shard, pushed on the same
 * writes, for data one of them already has.
 */
function OrganizationDashboard({ name, organizationId, orgRole, userId }: OrganizationDashboardProps) {
    const shard = { shardKey: organizationId };
    const payload = useQuery(api.saas.overview, {}, shard);

    /*
     * Who else has this page open. `usePresence` heartbeats on an interval and
     * on visibility changes, and subscribes to the room. The room is the
     * organisation, and so is the shard — the shard gate is what keeps another
     * tenant out of it, not the room name.
     *
     * This is the one screen in the kit that a request/response backend could
     * not render at all. Open a second tab and watch it: that is the whole
     * argument for the substrate, in a component that takes rows as props like
     * every other one.
     */
    const { present } = usePresence(organizationId, {
        data: { name: name ?? "Anonymous" },
        heartbeat: api.presence.heartbeat,
        listPresent: api.presence.listPresent,
        ...shard,
    });
    // `useMutation` returns `{ mutate, pending, … }` rather than a callable —
    // destructure at the call site so the React linter tracks each field.
    const { mutate: createProject } = useMutation(api.saas.createProject);
    const { mutate: archiveProject } = useMutation(api.saas.archiveProject);

    // The clock is read once per mount and passed down, so "4m ago" is stable
    // within a render pass and the server render agrees with its hydration.
    const [now] = useState(() => Date.now());

    /*
     * The cards hand back a plain string id — they are framework-agnostic and
     * know nothing about branded `Id<"saas_projects">` types — so the cast
     * happens here, at the one boundary that owns the mutation. Named rather
     * than `as never`: the id IS one of these, and a reader copying this line
     * should see which table it belongs to.
     */
    const archive = async (id: string) => archiveProject({ projectId: id as Id<"saas_projects"> }, shard); // secret-scanner:allow -- a mutation argument name, not a Cypress project id.
    const create = async (projectName: string) => createProject({ name: projectName }, shard);

    return (
        <main style={{ margin: "2rem auto", maxWidth: "56rem", padding: "0 1rem" }}>
            <PresenceBar currentUserId={userId} members={present} />
            <OverviewStats now={now} payload={payload} />
            <ProjectsCard
                // Only hides the controls — the mutations enforce the role
                // server-side either way.
                canWrite={orgRole?.split(",").some((role) => WRITER_ROLES.has(role.trim())) ?? false}
                onArchive={archive}
                onCreate={create}
                rows={payload?.projects}
            />
            <ActivityFeed now={now} rows={payload?.activity} />
        </main>
    );
}
