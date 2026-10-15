/**
 * Suspension on customer boxes (`celld-vps`, plan 365). A box serves exactly
 * the routing table the control plane pushes, and `routesForBox` leaves out a
 * suspended or over-cap organization's projects — so the box stops their
 * fleets (stops, never deletes) and starts them again when a later push names
 * them. Suspensions and recoveries happen in mutations (the spend-cap, dunning
 * and overage sweeps, support) that cannot reach a box's session, so this
 * every-minute sweep compares, for each online box, what its last finished
 * push withheld (`routesWithheld`, written by the session only once the table
 * was sent) against what its organizations' rows say now, and pushes again on
 * any difference — and whenever the last push did not finish (`routesStale`).
 *
 * Drift heals because nothing here is counted done until the session records
 * it: a push that throws, cannot reach the session, or finds the box not
 * connected leaves the record as it was (or marks it stale), and the next tick
 * compares again. An organization whose row cannot be read counts as withheld
 * (`boxProjects`). A reconnect pushes a fresh table on its own.
 */
import type { ControlPlaneStore } from "../d1-store";
import { drainTable } from "../store";
import { boxProjects } from "./session-store";

/** Boxes pushed per tick, so a mass suspension does not wake every session in one go. */
export const MAX_SUSPENSION_PUSHES_PER_TICK = 50;

interface BoxRow {
    _id: string;
    revokedAt?: null | number;
    routesStale?: boolean | null;
    routesWithheld?: null | string[];
    status: string;
}

export interface SuspensionSweepResult {
    /** Pushes that threw, or boxes whose projects could not be read — retried next tick. */
    failed: number;
    pushed: number;
    /** Boxes the session found not connected — retried next tick, and pushed on reconnect. */
    skipped: number;
}

const sameIds = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean => a.length === b.length && a.every((id, index) => id === b[index]);

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 256);

export const runBoxSuspensionSweep = async (
    database: ControlPlaneStore,
    options: { log: (line: string) => void; now: number; push: (boxId: string) => Promise<boolean> },
): Promise<SuspensionSweepResult> => {
    const result: SuspensionSweepResult = { failed: 0, pushed: 0, skipped: 0 };
    const rows = await drainTable<BoxRow>(database, "boxes");
    const boxes = rows.filter((box) => box.revokedAt == null && box.status === "online");
    let pushes = 0;

    for (const box of boxes) {
        if (pushes >= MAX_SUSPENSION_PUSHES_PER_TICK) {
            break;
        }

        let due = box.routesStale === true;

        if (!due) {
            try {
                // eslint-disable-next-line no-await-in-loop -- bounded; one box at a time keeps the read set flat
                const { withheld } = await boxProjects(database, box._id, options.now);

                due = !sameIds(withheld, box.routesWithheld ?? []);
            } catch (error) {
                // Cannot tell what the box should serve: push anyway — the session reads
                // the rows itself, and refuses to send what it cannot read.
                options.log(`[boxes] could not read box ${box._id}'s projects for the suspension sweep: ${messageOf(error)}`);
                due = true;
            }
        }

        if (!due) {
            continue;
        }

        pushes += 1;

        try {
            // The session recomputes the table from the rows at send time and records what it withheld.
            // eslint-disable-next-line no-await-in-loop -- bounded batch
            const pushed = await options.push(box._id);

            result[pushed ? "pushed" : "skipped"] += 1;
        } catch (error) {
            result.failed += 1;
            options.log(`[boxes] could not push box ${box._id}'s routes after a suspension change: ${messageOf(error)}`);
            // The session may never have run (unreachable); mark it so the next tick pushes regardless.
            // eslint-disable-next-line no-await-in-loop -- one row per failure
            await database.patch(box._id, { routesStale: true }, "boxes").catch(() => undefined);
        }
    }

    return result;
};
