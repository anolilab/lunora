import { useMutation, usePresence, useQuery } from "@lunora/react";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { api } from "../../lunora/_generated/api";
import type { Id } from "../../lunora/_generated/dataModel";
import { ActivityFeed, OverviewStats, PresenceBar, ProjectsCard } from "../../lunora/saas-ui/react";

import { authClient } from "../auth-client";

import "../../lunora/saas-ui/styles.css";

export const Route = createFileRoute("/dashboard")({
    component: DashboardPage,
});

/** Roles the server lets create and archive projects (`WRITER_ROLES` in `lunora/saas/index.ts`). */
const WRITER_ROLES = new Set(["admin", "owner"]);

/**
 * Actor id → display name for the activity feed. Activity rows carry only the
 * user id, and members live in better-auth's tables, so the names come from the
 * organization's member list; a user who is not in it (removed, or the list has
 * not loaded) reads as "Someone" rather than as a raw id.
 *
 * The list is fetched again whenever the feed changes, so a member who just joined
 * is named on their first activity. The names are kept with the organization they
 * were fetched for: after a switch, the previous organization's names never apply.
 */
const useMemberNames = (organizationId: string, feed: unknown): ((actorId: string) => string) => {
    const [lookup, setLookup] = useState<{ names: ReadonlyMap<string, string>; organizationId: string } | undefined>(undefined);

    useEffect(() => {
        let cancelled = false;

        void authClient.organization.getFullOrganization({ query: { organizationId } }).then(({ data }) => {
            if (!cancelled && data) {
                setLookup({ names: new Map(data.members.map((member) => [member.userId, member.user.name || member.user.email])), organizationId });
            }
        });

        return () => {
            cancelled = true;
        };
    }, [organizationId, feed]);

    return (actorId) => (lookup?.organizationId === organizationId ? lookup.names.get(actorId) : undefined) ?? "Someone";
};

/**
 * Who the caller is and which organisation they are in — read on the root
 * shard, because the organisation id is what every other call here needs to
 * know where to go.
 */
function DashboardPage() {
    // `authorizeShard` turns an anonymous caller away from every shard, the root
    // included, so a signed-out visitor sees this subscription fail rather than
    // resolve to `null`.
    //
    // A refused subscription keeps returning its last good value, so the refusal
    // has to win over it: otherwise a user who signs out, or is removed from the
    // organisation, keeps looking at its data. A new value is a new identity
    // (signed back in), which lifts the refusal.
    const [signedOut, setSignedOut] = useState(false);
    const me = useQuery(api.saas.me, {}, { onError: () => setSignedOut(true) });
    const [seen, setSeen] = useState(me);

    if (me !== seen) {
        setSeen(me);
        setSignedOut(false);
    }

    if (signedOut) {
        return (
            <main className="lu-saas-card" style={{ margin: "3rem auto", maxWidth: "44rem" }}>
                <p>Sign in to see your dashboard.</p>
            </main>
        );
    }

    if (me === undefined) {
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
    const resolveActor = useMemberNames(organizationId, payload?.activity);

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
        // Drops this session from the room at once on unmount, rather than after the TTL.
        leave: api.presence.leave,
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
    // Calendar days are the viewer's, not the Worker's (always UTC). The feed
    // only renders once its live query resolves in the browser, so this is the
    // browser's zone by then.
    const [timeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);

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
            <ActivityFeed now={now} resolveActor={resolveActor} rows={payload?.activity} timeZone={timeZone} />
        </main>
    );
}
