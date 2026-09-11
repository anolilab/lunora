/**
 * The row shapes the kit's queries return, restated here as plain types.
 *
 * They are NOT imported from a project's `lunora/_generated/` — this package is
 * a source-of-truth synced into registry items and copied into apps whose
 * generated types live at a path this file cannot know. Restating them keeps
 * the core compiling on its own; the `saas` registry item's schema is the
 * contract both sides answer to, and `registry/saas/schema.ts` is where it
 * lives.
 */

/** A row of `saas_projects`. */
interface ProjectRow {
    _creationTime: number;
    _id: string;
    archivedAt?: number;
    createdBy: string;
    name: string;
    organizationId: string;
    slug: string;
}

/** A row of `saas_activity`. */
interface ActivityRow {
    _creationTime: number;
    _id: string;
    action: string;
    actorId: string;
    createdAt: number;
    meta?: Record<string, unknown>;
    organizationId: string;
    subjectId?: string;
    subjectType: string;
}

/** A row of the `.global()` `saas_organizations` projection. */
interface OrganizationRow {
    _creationTime: number;
    _id: string;
    name: string;
    organizationId: string;
    plan: string;
    seats: number;
    slug: string;
    status: string;
    updatedAt: number;
}

/** What `api.saas.overview` resolves to. */
interface OverviewPayload {
    activity: ReadonlyArray<ActivityRow>;
    projects: ReadonlyArray<ProjectRow>;
}

/**
 * Where a flow is. `idle` before anything is attempted, `busy` while a mutation
 * is in flight, and the two terminals. Views map this to disabled buttons and
 * spinners; nothing here knows what a button is.
 */
type FlowStatus = "busy" | "error" | "idle" | "success";

export type { ActivityRow, FlowStatus, OrganizationRow, OverviewPayload, ProjectRow };
