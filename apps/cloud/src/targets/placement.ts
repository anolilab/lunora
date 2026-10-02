/**
 * Where a project's releases are converged — read from the database per
 * project, never from the process (plan 458 G3).
 *
 * The rule:
 *
 * 1. The TARGET is the project's (`projects.target`); a project that predates
 *    targets is `cloudflare-wfp`.
 * 2. A `cloudflare-wfp` tenant lives in its organization's CELL
 *    (`organizations.cellId` → `cells.name`): one Cloudflare account, one
 *    dispatch namespace, one control-plane deployment. `LUNORA_CELL` names the
 *    cell THIS control plane runs in and nothing else — it no longer decides
 *    where a release lands. A project whose organization is placed on another
 *    cell is refused, loudly: converging it here would put it in the wrong
 *    account, behind the wrong dispatcher, where nothing routes to it.
 * 3. A target placed some other way ignores the cell; its driver carries its
 *    own placement. A `celld-vps` project is placed on its BOX
 *    (`projects.boxId`), which must exist and not be revoked.
 */
import { LunoraError } from "@lunora/server";

import type { TargetId } from "../provision-contract";
import { targetOf } from "./registry";

/** A project's placement as stored (`internal.projects.placement`). */
export interface StoredPlacement {
    /** The box a `celld-vps` project is placed on, when it names one that exists. */
    box?: null | { id: string; revoked: boolean; slug: string };
    /** The name of the cell the project's organization is placed on. */
    cellName?: null | string;
    target?: null | string;
}

/** The box a `celld-vps` project converges on: its id (the session it is reached through) and its DNS label. */
export interface BoxPlacement {
    id: string;
    slug: string;
}

export interface Placement {
    /** Set exactly when `target` is `celld-vps`. */
    box?: BoxPlacement;
    target: TargetId;
}

/** The targets whose tenants live in the cell of the control plane that converges them. */
const CELL_PLACED: ReadonlySet<TargetId> = new Set(["cloudflare-wfp"]);

/**
 * Resolve a stored placement against the cell this control plane serves.
 * @throws {LunoraError} `CONFLICT` for an unknown target, a cell-placed project whose organization is on another cell (or on no registered cell), or a `celld-vps` project without a usable box.
 */
export const resolvePlacement = (stored: StoredPlacement, thisCell: string): Placement => {
    const target = targetOf(stored.target);

    if (target === "celld-vps") {
        if (stored.box == null) {
            throw new LunoraError("CONFLICT", "this project deploys to celld-vps but names no box; choose one in its settings");
        }

        if (stored.box.revoked) {
            throw new LunoraError("CONFLICT", "this project's box has been revoked; enrol the machine again and choose the new box");
        }

        return { box: { id: stored.box.id, slug: stored.box.slug }, target };
    }

    if (!CELL_PLACED.has(target)) {
        return { target };
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
