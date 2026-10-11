/**
 * App catalog installs: which of an organization's projects run a catalog app, at
 * which version and deployment. An install claims its project's row (`installing`)
 * before it writes anything, and becomes `live` once its release is up. A row left
 * `installing` by a crashed install stops blocking the project after its lease.
 *
 * The badge's two values, and what moves a row between them:
 * - `installing`: the install holds its project's claim (`activeKey` is the project id)
 *   and its release is not up yet. `finishInstall` ends it.
 * - `live`: the release is up. `activeKey` is `live:` followed by the install's id, and
 *   `deploymentId` names the deployment, which is the `deployments` row's id.
 * - removed, not moved to another status: a `live` row is deleted when its deployment is
 *   superseded (an activation or a rollback moves off it) or fails, because the app is no
 *   longer serving. `lunora/deployments.ts` does this. A row never leaves `installing` for
 *   a deployment event, so a claim is only ever ended by its own install.
 * A rollback back onto a superseded catalog deployment finds no row, so its badge stays
 * off until the app is installed again.
 *
 * Composed into the schema by `lunora/schema.ts`.
 */
import { defineTable, v } from "@lunora/server";

export const catalogTables = {
    catalogInstalls: defineTable({
        createdAt: v.number(),
        // The project id while the claim is held, then `live:<installId>` once the release is up.
        // A unique index refuses a second claim on one project; NULLs are distinct, so the
        // rows that carry no key never collide.
        activeKey: v.optional(v.string()),
        // Set once the release is live.
        deploymentId: v.optional(v.string()),
        installedBy: v.string(),
        organizationId: v.id("organizations"),
        projectId: v.id("projects"),
        slug: v.string(),
        status: v.union(v.literal("installing"), v.literal("live")),
        version: v.string(),
    })
        .global()
        .index("by_org", ["organizationId"])
        .index("by_project", ["projectId"])
        .index("by_active", ["activeKey"], { unique: true }),
};
