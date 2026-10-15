import { describe, expect, it } from "vitest";

import type { Id } from "../lunora/_generated/dataModel";
import type { MutationCtx } from "../lunora/_generated/server";
import { updateStatus } from "../lunora/deployments";
import { ALLOWED_TRANSITIONS, assertStatusMove } from "../src/deploy/status-transitions";
import withRateLimitStore from "./support/rate-limit-db";

type Row = Record<string, unknown>;
type Status = "building" | "destroyed" | "failed" | "live" | "provisioning" | "queued" | "superseded" | "verifying";
type Move = readonly [Status, Status];

const STATUSES: ReadonlyArray<Status> = ["queued", "provisioning", "building", "verifying", "live", "superseded", "failed", "destroyed"];

/**
 * Every status move the system performs, written out by hand from its writers
 * (the list in the commit message). The checks below hold the table against
 * this list, so the table is never checked against itself.
 */
const PERFORMED: ReadonlyArray<Move> = [
    ["queued", "provisioning"],
    ["queued", "failed"],
    ["queued", "destroyed"],
    ["provisioning", "provisioning"],
    ["provisioning", "verifying"],
    ["provisioning", "live"],
    ["provisioning", "failed"],
    ["provisioning", "destroyed"],
    ["building", "destroyed"],
    ["verifying", "verifying"],
    ["verifying", "live"],
    ["verifying", "failed"],
    ["verifying", "destroyed"],
    ["live", "live"],
    ["live", "superseded"],
    ["live", "failed"],
    ["live", "destroyed"],
    ["superseded", "live"],
    ["superseded", "destroyed"],
    ["failed", "failed"],
    ["failed", "destroyed"],
];

const isPerformed = (from: Status, to: Status): boolean => PERFORMED.some(([a, b]) => a === from && b === to);

/** Every other pair of statuses: the moves the table must refuse. */
const REFUSED: ReadonlyArray<Move> = STATUSES.flatMap((from) => STATUSES.filter((to) => !isPerformed(from, to)).map((to): Move => [from, to]));

const deploymentRow = (status: Status): Row => {
    return {
        _id: "dep_1",
        alias: "acme",
        createdAt: 1,
        kind: "production",
        organizationId: "org",
        projectId: "proj",
        scriptName: "acme",
        status,
        version: 3,
    };
};

/**
 * Fake mutation ctx over one deployment row. Records every patch so a refused
 * move can be asserted to have written nothing. The caller owns the org.
 */
const makeCtx = (row: Row): { ctx: MutationCtx; patched: { id: string; patch: Row }[] } => {
    const patched: { id: string; patch: Row }[] = [];
    const project = { _id: "proj", name: "Acme" };
    const members: Row[] = [{ organizationId: "org", role: "owner", userId: "user_1" }];
    const empty = () => Promise.resolve({ page: [] });

    const database = {
        alertRules: { findMany: empty },
        catalogInstalls: { findMany: empty },
        delete: () => Promise.resolve(),
        deployments: { findMany: empty },
        get: (id: string) => {
            if (id === row["_id"]) {
                return Promise.resolve(row);
            }

            return Promise.resolve(id === project._id ? project : null);
        },
        insert: (table: string) => Promise.resolve(`${table}_id`),
        members: { findMany: () => Promise.resolve({ page: members }) },
        notificationChannels: { findMany: empty },
        patch: (id: string, patch: Row) => {
            patched.push({ id, patch });

            return Promise.resolve();
        },
    };

    const ctx = {
        auth: { getIdentity: () => Promise.resolve(null), userId: "user_1" },
        now: Date.now(),
        db: withRateLimitStore(database),
        log: {},
        runMutation: () => Promise.resolve(undefined),
        runQuery: () => Promise.resolve(undefined),
        scheduler: {},
        storage: {},
        vectors: {},
    } as unknown as MutationCtx;

    return { ctx, patched };
};

const ID = "dep_1" as Id<"deployments">;

const byMove = (a: Move, b: Move): number => `${a[0]}>${a[1]}`.localeCompare(`${b[0]}>${b[1]}`);

describe("updateStatus against the deployment transition table", () => {
    it("lists exactly the performed moves, no more and no fewer", () => {
        const table = STATUSES.flatMap((from) => ALLOWED_TRANSITIONS[from].map((to): Move => [from, to]));

        expect([...table].toSorted(byMove)).toStrictEqual([...PERFORMED].toSorted(byMove));
    });

    it.each(PERFORMED)("allows %s -> %s and writes the new status", async (from, to) => {
        const { ctx, patched } = makeCtx(deploymentRow(from));

        await updateStatus.handler(ctx, { id: ID, status: to });

        expect(patched).toHaveLength(1);
        expect(patched[0]?.patch).toMatchObject({ status: to });
    });

    it.each(REFUSED)("refuses %s -> %s with a CONFLICT naming both statuses, and writes nothing", async (from, to) => {
        const { ctx, patched } = makeCtx(deploymentRow(from));

        await expect(updateStatus.handler(ctx, { id: ID, status: to })).rejects.toMatchObject({
            code: "CONFLICT",
            message: `cannot move a ${from} deployment to ${to}`,
        });
        expect(patched).toHaveLength(0);
    });

    it("refuses a destroyed deployment being brought back to live", async () => {
        const { ctx, patched } = makeCtx(deploymentRow("destroyed"));

        await expect(updateStatus.handler(ctx, { id: ID, status: "live" })).rejects.toThrow("cannot move a destroyed deployment to live");
        expect(patched).toHaveLength(0);
    });

    it("stamps the phase timestamp of the status entered, in the same write", async () => {
        const { ctx, patched } = makeCtx(deploymentRow("verifying"));

        await updateStatus.handler(ctx, { id: ID, status: "live" });

        expect(patched[0]?.patch).toMatchObject({ liveAt: ctx.now, status: "live" });
    });

    it("re-stamps the failure timestamp when a retry writes failed over failed", async () => {
        const { ctx, patched } = makeCtx(deploymentRow("failed"));

        await updateStatus.handler(ctx, { id: ID, status: "failed" });

        expect(patched[0]?.patch).toMatchObject({ failedAt: ctx.now, status: "failed" });
    });
});

/** The error a call throws, or `undefined` when it does not throw. */
const thrownBy = (action: () => void): unknown => {
    try {
        action();
    } catch (error) {
        return error;
    }

    return undefined;
};

describe("assertStatusMove, the check every direct status writer runs", () => {
    it.each(PERFORMED)("allows %s -> %s", (from, to) => {
        expect(
            thrownBy(() => {
                assertStatusMove(from, to);
            }),
        ).toBeUndefined();
    });

    it.each(REFUSED)("refuses %s -> %s with a CONFLICT naming both statuses", (from, to) => {
        expect(
            thrownBy(() => {
                assertStatusMove(from, to);
            }),
        ).toMatchObject({
            code: "CONFLICT",
            message: `cannot move a ${from} deployment to ${to}`,
        });
    });

    it("refuses a stored status the table does not know, rather than treating it as a move", () => {
        expect(
            thrownBy(() => {
                assertStatusMove("archived", "live");
            }),
        ).toMatchObject({ code: "CONFLICT" });
    });
});
