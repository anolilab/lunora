/**
 * Suspension on customer boxes (`celld-vps`, plan 365). A box serves exactly
 * the routing table the control plane pushes, and `routesForBox` leaves out a
 * suspended or over-cap organization's projects — so the box stops their
 * fleets (stops, never deletes) and starts them again when a later push names
 * them. Suspensions and recoveries happen in mutations (the spend-cap, dunning
 * and overage sweeps, support) that cannot reach a box's session, so this
 * every-minute sweep finds each online box whose last push (`routesWithheld`)
 * no longer matches what its organizations' rows say now, and pushes again.
 * A reconnect pushes a fresh table on its own; an offline box is left to it.
 */
import type { ControlPlaneStore } from "../d1-store";
import { drainTable } from "../store";
import { boxProjects } from "./session-store";

/** Boxes pushed per tick, so a mass suspension does not wake every session in one go. */
export const MAX_SUSPENSION_PUSHES_PER_TICK = 50;

interface BoxRow {
    _id: string;
    revokedAt?: null | number;
    routesWithheld?: null | string[];
    status: string;
}

export interface SuspensionSweepResult {
    failed: number;
    pushed: number;
}

const sameIds = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean => a.length === b.length && a.every((id, index) => id === b[index]);

export const runBoxSuspensionSweep = async (
    database: ControlPlaneStore,
    options: { log: (line: string) => void; now: number; push: (boxId: string) => Promise<boolean> },
): Promise<SuspensionSweepResult> => {
    const result: SuspensionSweepResult = { failed: 0, pushed: 0 };
    const rows = await drainTable<BoxRow>(database, "boxes");
    const boxes = rows.filter((box) => box.revokedAt == null && box.status === "online");
    let pushes = 0;

    for (const box of boxes) {
        if (pushes >= MAX_SUSPENSION_PUSHES_PER_TICK) {
            break;
        }

        // eslint-disable-next-line no-await-in-loop -- bounded; one box at a time keeps the read set flat
        const { withheld } = await boxProjects(database, box._id, options.now);

        if (sameIds(withheld, box.routesWithheld ?? [])) {
            continue;
        }

        pushes += 1;

        try {
            // The push recomputes the table from the rows and records what it withheld.
            // eslint-disable-next-line no-await-in-loop -- bounded batch
            if (await options.push(box._id)) {
                result.pushed += 1;
            }
        } catch (error) {
            result.failed += 1;
            options.log(`[boxes] could not push box ${box._id}'s routes after a suspension change: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return result;
};
