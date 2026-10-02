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
 * 3. A target placed some other way (a box, a customer's own account) ignores
 *    the cell; its driver carries its own placement.
 */
import { LunoraError } from "@lunora/server";

import type { TargetId } from "../provision-contract";
import { targetOf } from "./registry";

/** A project's placement as stored (`internal.projects.placement`). */
export interface StoredPlacement {
    /** The name of the cell the project's organization is placed on. */
    cellName?: null | string;
    target?: null | string;
}

export interface Placement {
    target: TargetId;
}

/** The targets whose tenants live in the cell of the control plane that converges them. */
const CELL_PLACED: ReadonlySet<TargetId> = new Set(["cloudflare-wfp"]);

/**
 * Resolve a stored placement against the cell this control plane serves.
 * @throws {LunoraError} `CONFLICT` for an unknown target, or a cell-placed project whose organization is on another cell (or on no registered cell).
 */
export const resolvePlacement = (stored: StoredPlacement, thisCell: string): Placement => {
    const target = targetOf(stored.target);

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
