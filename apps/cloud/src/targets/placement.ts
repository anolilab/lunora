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
 *
 * The fleet-wide sweeps place a DEPLOYMENT rather than a project — its project
 * may be gone — through {@link placementOfDeployment}, off the box its row names.
 */
import { LunoraError } from "@lunora/server";

import type { ControlPlaneStore } from "../d1-store";
import type { BoxTargetId, CellTargetId, TargetId } from "../provision-contract";
import { isBoxTarget, storedTarget, TARGET_IDS } from "../provision-contract";

/** A box as placement reads it. `.global()` rows answer SQL NULL for an unset column. */
export interface StoredBox {
    id: string;
    revoked: boolean;
    slug: string;
}

/** A project's placement as stored (`internal.projects.placement`). */
export interface StoredPlacement {
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
export type Placement = { box: BoxPlacement; target: BoxTargetId } | { target: CellTargetId };

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
 * @throws {LunoraError} `CONFLICT` for an unknown target, a cell-placed project whose organization is on another cell (or on no registered cell), or a box-placed project without a usable box.
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
 * predates the column.
 */
export const placementOfDeployment = async (
    deployment: { alias: string; boxId?: null | string; target: TargetId },
    boxes: BoxLookups,
): Promise<DeploymentPlacement> => {
    const { alias, boxId, target } = deployment;

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
