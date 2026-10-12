/**
 * The catalog install badge's rule, in one place. A `live` `catalogInstalls` row names
 * the deployment its release went live as (`deploymentId`). The badge follows that
 * deployment:
 *
 * - when the deployment stops serving (superseded by an activation, a rollback, or a
 *   resume onto another release, or failed), its live row is removed;
 * - when the deployment goes live again (an activation or a rollback back onto it), its
 *   row is restored, or re-created from the provenance the deployment kept at install
 *   (`catalogSlug`, `catalogVersion`, `catalogInstalledBy`, written by `finishInstall`).
 *
 * Only `live` rows are touched. An `installing` row belongs to its install's claim, and
 * `finishInstall` is what marks it live. A deployment that no install row names, or that
 * carries no provenance (every non-catalog deployment, and any released before the
 * provenance was recorded), matches nothing.
 *
 * Both callers pass their own database through {@link InstallBadgeStore}: the Lunora
 * mutations (`lunora/deployments.ts`, `lunora/catalog.ts`) and the emergency stop's
 * control-plane store (`deploy/halt-converge.ts`).
 */

/** A `catalogInstalls` row as the badge rule reads it. */
export interface BadgeInstall {
    _id: string;
    activeKey?: string;
    createdAt: number;
    deploymentId?: string;
    installedBy: string;
    organizationId: string;
    projectId: string;
    slug: string;
    status: "installing" | "live";
    version: string;
}

/** The deployment fields the badge rule reads. */
export interface BadgeDeployment {
    _id: string;
    catalogInstalledBy?: null | string;
    catalogSlug?: null | string;
    catalogVersion?: null | string;
    organizationId: string;
    projectId: string;
}

/** The `catalogInstalls` table as the badge rule needs it. Each caller adapts its own database to this. */
export interface InstallBadgeStore {
    delete: (id: string) => Promise<unknown>;
    /** Insert a row, returning its id. */
    insert: (row: Omit<BadgeInstall, "_id" | "activeKey" | "status"> & { deploymentId: string; status: "live" }) => Promise<string>;
    installsOf: (projectId: string) => Promise<BadgeInstall[]>;
    patch: (id: string, values: Partial<Pick<BadgeInstall, "activeKey">>) => Promise<unknown>;
}

/** A deployment stopped serving: remove the live install row that names it. */
export const endInstallBadge = async (store: InstallBadgeStore, deployment: Pick<BadgeDeployment, "_id" | "projectId">): Promise<void> => {
    for (const install of await store.installsOf(deployment.projectId)) {
        if (install.status === "live" && install.deploymentId === deployment._id) {
            // eslint-disable-next-line no-await-in-loop -- a handful of installs per project
            await store.delete(install._id);
        }
    }
};

/**
 * A deployment is live again: make sure a live row names it. A row already naming it is
 * left as it is. Otherwise a row is re-created from the deployment's provenance, which
 * is absent for a non-catalog deployment, so nothing is written for one.
 */
export const restoreInstallBadge = async (store: InstallBadgeStore, deployment: BadgeDeployment, now: number): Promise<void> => {
    const { catalogInstalledBy: installedBy, catalogSlug: slug, catalogVersion: version } = deployment;

    if (installedBy == null || slug == null || version == null) {
        return;
    }

    const installs = await store.installsOf(deployment.projectId);

    if (installs.some((install) => install.status === "live" && install.deploymentId === deployment._id)) {
        return;
    }

    // Insert without an activeKey, then key the row on its own id: the same order
    // `claimInstall` and `finishInstall` use, so the unique `by_active` index never sees
    // a second claim on the project.
    const id = await store.insert({
        createdAt: now,
        deploymentId: deployment._id,
        installedBy,
        organizationId: deployment.organizationId,
        projectId: deployment.projectId,
        slug,
        status: "live",
        version,
    });

    await store.patch(id, { activeKey: `live:${id}` });
};
