/**
 * Where a project's releases are converged — read from the database per
 * project, never from the process (plan 458 G3).
 *
 * The rule:
 *
 * 1. The TARGET is the project's (`projects.target`); a project that predates
 *    targets is `cloudflare-wfp`.
 * 2. A target placed in a CELL (`TARGETS[target].placedOn === "cell"`) puts its
 *    tenant in its organization's cell (`organizations.cellId` → `cells.name`):
 *    one Cloudflare account, one dispatch namespace, one control-plane
 *    deployment. `LUNORA_CELL` names the cell THIS control plane runs in and
 *    nothing else — it no longer decides where a release lands. A project whose
 *    organization is placed on another cell is refused, loudly: converging it
 *    here would put it in the wrong account, behind the wrong dispatcher, where
 *    nothing routes to it.
 * 3. A target placed on a BOX ignores the cell: the project names its box
 *    (`projects.boxId`), which must exist and not be revoked.
 * 4. A target placed in an ACCOUNT puts the tenant in a Cloudflare account its
 *    organization connected (`projects.cloudflareAccountId`), and is still
 *    converged by the organization's cell: that cell's provision box holds the
 *    convergence state (MULTIPLATFORM.md §5.3), and its sweeps read the
 *    account's usage — so rule 2's cell check applies to it too.
 *
 * The fleet-wide sweeps place a DEPLOYMENT rather than a project — its project
 * may be gone — through {@link placementOfDeployment}, off the box or account
 * its row names.
 */
import { LunoraError } from "@lunora/server";

import type { ControlPlaneStore } from "../d1-store";
import type { AccountTargetId, BoxTargetId, CellTargetId, TargetId } from "../provision-contract";
import { isAccountTarget, isBoxTarget, storedTarget, TARGET_IDS } from "../provision-contract";

/** A box as placement reads it. `.global()` rows answer SQL NULL for an unset column. */
export interface StoredBox {
    id: string;
    revoked: boolean;
    slug: string;
}

/**
 * A connected Cloudflare account as placement reads it: the row id (what the
 * driver unseals the token by), the account's own id, and its `workers.dev`
 * subdomain. Never the token.
 */
export interface AccountPlacement {
    accountId: string;
    id: string;
    workersSubdomain: string;
}

/** A project's placement as stored (`internal.projects.placement`). */
export interface StoredPlacement {
    /** The connected account an account-placed project names, when it names one of its organization's. */
    account?: AccountPlacement | null;
    /** The box a box-placed project names, when it names one that exists. */
    box?: null | StoredBox;
    /** The name of the cell the project's organization is placed on. */
    cellName?: null | string;
    target?: null | string;
}

/** The box a box-placed project converges on: its id (the session it is reached through) and its DNS label. */
export interface BoxPlacement {
    id: string;
    slug: string;
}

/** Where a release converges: in this control plane's cell, or on the project's box. */
export type Placement = { account: AccountPlacement; target: AccountTargetId } | { box: BoxPlacement; target: BoxTargetId } | { target: CellTargetId };

/** The refusal for a revoked box, whoever meets it first: choosing a target, or deploying to it. */
export const revokedBoxError = (box: string): LunoraError =>
    new LunoraError("CONFLICT", `box "${box}" is revoked; enrol the machine again and choose the new box`);

/**
 * Parse a stored `target` column like `storedTarget`, refusing a value no target answers to.
 * @throws {LunoraError} `CONFLICT` for an unknown target.
 */
export const targetOf = (stored: null | string | undefined): TargetId => {
    const target = storedTarget(stored);

    if (target === undefined) {
        throw new LunoraError("CONFLICT", `unknown deploy target "${String(stored)}" — known targets: ${TARGET_IDS.join(", ")}`);
    }

    return target;
};

/**
 * Resolve a stored placement against the cell this control plane serves.
 * @throws {LunoraError} `CONFLICT` for an unknown target, a cell- or account-placed project whose organization is on another cell (or on no registered cell), a box-placed project without a usable box, or an account-placed project without a connected account.
 */
export const resolvePlacement = (stored: StoredPlacement, thisCell: string): Placement => {
    const target = targetOf(stored.target);

    if (isBoxTarget(target)) {
        if (stored.box == null) {
            throw new LunoraError("CONFLICT", `this project deploys to ${target} but names no box; choose one in its settings`);
        }

        if (stored.box.revoked) {
            throw revokedBoxError(stored.box.slug);
        }

        return { box: { id: stored.box.id, slug: stored.box.slug }, target };
    }

    if (stored.cellName == null) {
        throw new LunoraError("CONFLICT", "this project's organization is not placed on a registered cell, so no control plane may deploy it");
    }

    if (stored.cellName !== thisCell) {
        throw new LunoraError(
            "CONFLICT",
            `this project's organization is placed on cell "${stored.cellName}", but this control plane serves cell "${thisCell}" — deploy through that cell's control plane`,
        );
    }

    if (isAccountTarget(target)) {
        if (stored.account == null) {
            throw new LunoraError("CONFLICT", `this project deploys to ${target} but names no connected Cloudflare account; choose one in its settings`);
        }

        return { account: { accountId: stored.account.accountId, id: stored.account.id, workersSubdomain: stored.account.workersSubdomain }, target };
    }

    return { target };
};

/** The box reads {@link placementOfDeployment} needs. */
export interface BoxLookups {
    /** The box row `id`, or `null` when there is none (deleted with its organization). */
    byId: (id: string) => Promise<null | StoredBox>;
    /** The box a deployed alias lives on, through its owning project — for a row that predates `deployments.boxId`. */
    forAlias: (alias: string) => Promise<null | StoredBox>;
}

interface BoxRow {
    _id: string;
    slug: string;
    status: string;
}

const storedBox = (row: BoxRow | null | undefined): null | StoredBox => (row ? { id: row._id, revoked: row.status === "revoked", slug: row.slug } : null);

/** The {@link BoxLookups} over the control-plane store. */
export const boxLookupsIn = (database: ControlPlaneStore): BoxLookups => {
    return {
        byId: async (id) => storedBox((await database.get(id, "boxes")) as BoxRow | null),
        // alias → its owning project (`aliasOwnership`) → the project's box.
        forAlias: async (alias) => {
            const { page: owners } = await database.findMany("aliasOwnership", { where: { alias } });
            const owner = owners[0] as undefined | { projectId: string };
            const project = owner ? ((await database.get(owner.projectId, "projects")) as null | { boxId?: null | string }) : null;

            return project?.boxId == null ? null : storedBox((await database.get(project.boxId, "boxes")) as BoxRow | null);
        },
    };
};

/** The account read {@link placementOfDeployment} needs: the connection row `id`, or `null` once it is disconnected (or erased with its organization). */
export type AccountLookup = (id: string) => Promise<AccountPlacement | null>;

/** The {@link AccountLookup} over the control-plane store. */
export const accountLookupIn =
    (database: ControlPlaneStore): AccountLookup =>
    async (id) => {
        const row = (await database.get(id, "cloudflareAccounts")) as null | { _id: string; accountId: string; workersSubdomain: string };

        return row ? { accountId: row.accountId, id: row._id, workersSubdomain: row.workersSubdomain } : null;
    };

/**
 * Where a deployment's tenant lives, or why it lives nowhere this control plane
 * can reach. `settled` says whether that is final — the tenant is beyond reach
 * for good, so a teardown may release its alias — or may change, in which case
 * the alias must stay claimed and the row pending.
 */
export type DeploymentPlacement = { placement: Placement } | { settled: boolean; unplaced: string };

/**
 * Place one deployment for a fleet-wide sweep, off the box its row names
 * (`deployments.boxId`), falling back to its owning project's box for a row that
 * predates the column — or off the connected account it names
 * (`deployments.cloudflareAccountId`).
 */
export const placementOfDeployment = async (
    deployment: { alias: string; boxId?: null | string; cloudflareAccountId?: null | string; target: TargetId },
    boxes: BoxLookups,
    accounts: AccountLookup,
): Promise<DeploymentPlacement> => {
    const { alias, boxId, cloudflareAccountId, target } = deployment;

    if (isAccountTarget(target)) {
        const account = cloudflareAccountId == null ? null : await accounts(cloudflareAccountId);

        // Disconnecting is refused while a deployment is pending, so a missing
        // row means the organization was erased with it: the Worker and its data
        // are in the customer's own account, which nothing here can reach any more.
        return account === null
            ? { settled: true, unplaced: "its Cloudflare account is no longer connected; the Worker and its data stay in that account" }
            : { placement: { account, target } };
    }

    if (!isBoxTarget(target)) {
        return { placement: { target } };
    }

    const box = boxId == null ? await boxes.forAlias(alias) : await boxes.byId(boxId);

    if (box === null) {
        // The row names a box that no longer exists: deleted with its organization,
        // so nothing can reach the machine any more. A row that names none, whose
        // project is gone, may still have a fleet and data on a box nobody can
        // name — releasing its alias would let another project land on them.
        return boxId == null
            ? { settled: false, unplaced: "has no box this control plane can resolve; its fleet cannot be stopped, so the alias stays claimed" }
            : { settled: true, unplaced: `box ${boxId} no longer exists; nothing to stop` };
    }

    // Nothing CAN be reached on a revoked box: it is cut off, and its data is the
    // customer's bucket to keep or delete.
    if (box.revoked) {
        return { settled: true, unplaced: `box "${box.slug}" is revoked; its fleet and data stay on the machine` };
    }

    return { placement: { box: { id: box.id, slug: box.slug }, target } };
};
