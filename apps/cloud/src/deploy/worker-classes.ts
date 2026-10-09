/**
 * Which Durable Object and Workflow classes each alias's Worker actually runs.
 *
 * On a target that drops unbound classes (`TARGETS[target].dropsUnboundClasses`)
 * a converge deletes the data of every class the new script stops binding. So
 * the classes that can hold data are exactly those of the script on the
 * Worker now — not every release that ever went live (a class an earlier
 * release dropped already lost its data), and not the live deployment row's
 * (a failed health check whose revert also failed leaves the newer release on
 * the Worker). Deployment rows and retained bundles cannot answer this; the
 * converges can, so each records it on the alias's ownership row:
 *
 * - right before the provision job, a **pending** entry with the release's
 *   classes — refused, and the converge with it, if the write fails;
 * - on success, those classes become **`workerClasses`**, and pending entries
 *   this converge supersedes are dropped (the provision box runs one job per
 *   alias at a time, so a later success is what the Worker runs);
 * - on a failure that provably uploaded nothing (the box was busy, or the
 *   project step failed before the Worker step ran) the entry is dropped; any
 *   other failure keeps it, stamped `endedAt`: the job may have uploaded the
 *   script before it failed, so its classes may be on the Worker.
 *
 * {@link classesOnWorker} is `workerClasses` ∪ every pending entry: what an
 * emergency stop's stub keeps, and what its resume must not drop. Every
 * converge records it — the deploy edge's (deploys, reverts, rollbacks,
 * git-build releases) and the halt sweep's own stub and resume converges.
 */
import { isLunoraError } from "@lunora/errors";

import type { ControlPlaneStore } from "../d1-store";
import { TARGETS } from "../provision-contract";
import type { TargetDriver } from "../targets/driver";
import type { BoundClass } from "./halt-stub";
import { classesOf, mergeClasses } from "./halt-stub";

/** One converge whose outcome is not known yet, or never will be. */
export interface PendingConverge {
    classes: BoundClass[];
    /** Set once it failed in a way that may have uploaded the script. */
    endedAt?: null | number;
    startedAt: number;
    token: string;
}

interface OwnershipRow {
    _id: string;
    alias: string;
    pendingClasses?: null | PendingConverge[];
    projectId: string;
    workerClasses?: BoundClass[] | null;
}

/** A pending entry with no outcome this long after it started is superseded by a later success (a provision job never runs this long). */
export const PENDING_STALE_MS = 60 * 60 * 1000;

/** How a converge ended, as far as the classes on the Worker go. */
export type ConvergeOutcome = "failed" | "not-uploaded" | "succeeded";

const ownershipOf = async (store: ControlPlaneStore, alias: string): Promise<OwnershipRow | undefined> => {
    const { page } = await store.findMany("aliasOwnership", { limit: 1, where: { alias } });

    return page[0] as OwnershipRow | undefined;
};

/**
 * Record a converge about to start. Throws when the alias has no ownership
 * row or the write fails — the caller must not converge then, or classes it
 * puts on the Worker would go unrecorded.
 */
export const beginConverge = async (store: ControlPlaneStore, input: { alias: string; classes: BoundClass[]; now: number; token: string }): Promise<void> => {
    const row = await ownershipOf(store, input.alias);

    if (row === undefined) {
        throw new Error(`alias ${input.alias} has no ownership row, so the classes a converge puts on its Worker could not be recorded; nothing was converged`);
    }

    await store.patch(
        row._id,
        { pendingClasses: [...(row.pendingClasses ?? []), { classes: input.classes, startedAt: input.now, token: input.token }] },
        "aliasOwnership",
    );
};

/** Record how a converge ended. */
export const endConverge = async (store: ControlPlaneStore, input: { alias: string; now: number; outcome: ConvergeOutcome; token: string }): Promise<void> => {
    const row = await ownershipOf(store, input.alias);

    if (row === undefined) {
        return;
    }

    const pending = row.pendingClasses ?? [];
    const mine = pending.find((entry) => entry.token === input.token);
    const others = pending.filter((entry) => entry.token !== input.token);

    if (input.outcome === "succeeded") {
        const startedAt = mine?.startedAt ?? input.now;

        await store.patch(
            row._id,
            {
                pendingClasses: others.filter(
                    (entry) =>
                        !(entry.endedAt != null && entry.endedAt <= startedAt) && !(entry.endedAt == null && entry.startedAt < startedAt - PENDING_STALE_MS),
                ),
                workerClasses: mine?.classes ?? row.workerClasses ?? [],
            },
            "aliasOwnership",
        );

        return;
    }

    await store.patch(
        row._id,
        { pendingClasses: input.outcome === "not-uploaded" || mine === undefined ? others : [...others, { ...mine, endedAt: input.now }] },
        "aliasOwnership",
    );
};

/**
 * What the record says may be on the alias's Worker: `workerClasses` ∪ every
 * pending converge's classes. `recorded` is false for an alias no recording
 * converge has confirmed yet (one that predates the record), whose caller
 * falls back to the live release's manifest.
 */
export const classesOnWorker = async (store: ControlPlaneStore, alias: string): Promise<{ classes: BoundClass[]; recorded: boolean }> => {
    const row = await ownershipOf(store, alias);
    const pending = (row?.pendingClasses ?? []).map((entry) => entry.classes);

    return { classes: mergeClasses([row?.workerClasses ?? [], ...pending]), recorded: row?.workerClasses != null };
};

/**
 * Whether a failed provision job provably never uploaded the script: the box
 * was busy with another job for the alias (409), or Alchemy failed on the
 * project stack, which runs before the Worker stack (`containers/provision/server.mjs`).
 * Anything else may have failed after the upload.
 */
export const uploadedNothing = (error: unknown): boolean =>
    (isLunoraError(error) && error.code === "SERVICE_UNAVAILABLE") || (error instanceof Error && error.message.startsWith("alchemy deploy of lunora-project-"));

/** Where a converge records itself — the store directly (the halt sweep) or the deploy edge's internal mutations. */
export interface ConvergeRecorder {
    begin: (input: { alias: string; classes: BoundClass[]; now: number; token: string }) => Promise<void>;
    end: (input: { alias: string; now: number; outcome: ConvergeOutcome; token: string }) => Promise<void>;
}

/**
 * Run one converge onto `alias`'s Worker, recorded: begin (refusing the
 * converge if that fails), converge, end. The end write is best-effort — the
 * converge already happened, and a lost end leaves the entry pending, which
 * only ever keeps more classes.
 */
export const recordedConverge = async <T>(
    recorder: ConvergeRecorder,
    input: { alias: string; classes: BoundClass[]; clock?: () => number },
    converge: () => Promise<T>,
): Promise<T> => {
    const clock = input.clock ?? Date.now;
    const token = crypto.randomUUID();

    await recorder.begin({ alias: input.alias, classes: input.classes, now: clock(), token });

    let outcome: ConvergeOutcome = "failed";

    try {
        const result = await converge();

        outcome = "succeeded";

        return result;
    } catch (error) {
        outcome = uploadedNothing(error) ? "not-uploaded" : "failed";

        throw error;
    } finally {
        await recorder.end({ alias: input.alias, now: clock(), outcome, token }).catch(() => undefined);
    }
};

/** A {@link ConvergeRecorder} over the control-plane store. */
export const storeRecorder = (store: ControlPlaneStore): ConvergeRecorder => {
    return {
        begin: async (input) => beginConverge(store, input),
        end: async (input) => endConverge(store, input),
    };
};

/**
 * A driver whose every converge onto a target that drops unbound classes is
 * recorded through `recorder` ({@link recordedConverge}); on any other target
 * the driver itself — no converge there can delete a class's data.
 */
export const recordingDriver = (driver: TargetDriver, recorder: ConvergeRecorder): TargetDriver =>
    TARGETS[driver.id].dropsUnboundClasses
        ? {
              ...driver,
              deploy: async (spec, options) =>
                  recordedConverge(recorder, { alias: spec.alias, classes: classesOf(spec.manifest) }, async () => driver.deploy(spec, options)),
          }
        : driver;
