import { useMutation, usePresence, useQuery } from "@lunora/react";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { api } from "../../lunora/_generated/api";
import { ActivityFeed, OverviewStats, PresenceBar, ProjectsCard } from "../../lunora/saas-ui/react";

import "../../lunora/saas-ui/styles.css";

export const Route = createFileRoute("/dashboard")({
    component: DashboardPage,
});

/**
 * The dashboard. This route owns the subscription and the mutations; the cards
 * own the pixels — which is why they take rows as props and never call
 * `useQuery` themselves.
 *
 * One `api.saas.overview` subscription feeds both cards. Two queries would be
 * two subscriptions over the same shard, pushed on the same writes, for data one
 * of them already has.
 */
/*
 * Wire these to your session. The room is the organization id — presence is
 * per-tenant because everything else here is — and the name and id come off the
 * better-auth session your app already has client-side.
 */
const ORGANIZATION_ROOM = "demo-organization";
const VIEWER_NAME = "You";
const VIEWER_ID: string | undefined = undefined;

function DashboardPage() {
    const payload = useQuery(api.saas.overview, {});

    /*
     * Who else has this page open. `usePresence` heartbeats on an interval and
     * on visibility changes, and subscribes to the room — here the organization,
     * so presence is scoped to the tenant exactly like its data is.
     *
     * This is the one screen in the kit that a request/response backend could
     * not render at all. Open a second tab and watch it: that is the whole
     * argument for the substrate, in a component that takes rows as props like
     * every other one.
     */
    const { present } = usePresence(ORGANIZATION_ROOM, {
        data: { name: VIEWER_NAME },
        heartbeat: api.presence.heartbeat,
        listPresent: api.presence.listPresent,
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
     * happens here, at the one boundary that owns the mutation.
     */
    const archive = async (id: string) => archiveProject({ projectId: id as never }); // secret-scanner:allow -- a mutation argument name, not a Cypress project id.
    const create = async (name: string) => createProject({ name });

    return (
        <main style={{ margin: "2rem auto", maxWidth: "56rem", padding: "0 1rem" }}>
            <PresenceBar currentUserId={VIEWER_ID} members={present} />
            <OverviewStats now={now} payload={payload} />
            <ProjectsCard
                // Replace with the caller's real role once your app reads it —
                // `orgRole` is on the identity, and the mutation enforces it
                // server-side either way.
                canWrite
                onArchive={archive}
                onCreate={create}
                rows={payload?.projects}
            />
            <ActivityFeed now={now} rows={payload?.activity} />
        </main>
    );
}
