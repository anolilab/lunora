import { describe, expect, it } from "vitest";

import type { MutationCtx } from "../lunora/_generated/server";
import { enforceSpendCaps, ingest, rollup } from "../lunora/usage";
import { hashDeployKey } from "../src/deploy/keys";

/**
 * The money mutations, which had no tests at all.
 *
 * `rollup` is the only place in the system that can DOUBLE-bill, and the thing
 * that prevents it is statement order alone: the extras are deleted before the
 * survivor's total is written, so a crash mid-compaction can only under-count.
 * Reverse those two awaits and every org with a multi-row meter group gets
 * over-charged, with nothing failing. That invariant had no test.
 *
 * `enforceSpendCaps` is the runaway-bill brake. A regression that fails to
 * suspend costs the platform unbounded money; one that lifts a *dunning*
 * suspension restores service to an org that is not paying.
 *
 * `ingest` is called with a tenant-held deploy key, so its negative-quantity
 * guard is what stops a tenant deflating its own metered usage.
 */

type Row = Record<string, unknown>;

/** Every db call the mutation made, in order — which is the property under test for `rollup`. */
type Op = { id: string; kind: "delete" } | { id: string; kind: "patch"; patch: Row } | { document: Row; kind: "insert"; table: string };

const makeCtx = (tables: Record<string, Row[]>, now = 1_700_000_000_000): { ctx: MutationCtx; ops: Op[] } => {
    const ops: Op[] = [];
    const matchesEntry = (actual: unknown, expected: unknown): boolean => {
        const comparison = expected as { gte?: number; lt?: number };

        if (typeof expected === "object" && expected !== null && ("lt" in expected || "gte" in expected)) {
            return (
                (comparison.lt === undefined || (actual as number) < comparison.lt) && (comparison.gte === undefined || (actual as number) >= comparison.gte)
            );
        }

        return actual === expected;
    };
    const matches = (row: Row, where: Row): boolean => Object.entries(where).every(([key, value]) => matchesEntry(row[key], value));
    const select = (table: string, where: Row): Row[] => (tables[table] ?? []).filter((row) => matches(row, where));
    const facade = (table: string) => {
        return {
            findMany: (args?: { orderBy?: Record<string, string>[]; where?: Row }) =>
                Promise.resolve({ continueCursor: null, isDone: true, page: select(table, args?.where ?? {}) }),
        };
    };

    // `ingest` carries `.use(rateLimit("ingest"))`, and `.handler` runs the
    // middleware chain — so the double must also satisfy the limiter's store: a
    // `query(table).withIndex(...).first()` that finds no bucket, which is the
    // first-request path and always allows.
    const emptyQuery: { first: () => Promise<null>; withIndex: () => typeof emptyQuery } = { first: () => Promise.resolve(null), withIndex: () => emptyQuery };

    const ctx = {
        auth: { getIdentity: () => Promise.resolve(null), userId: null },
        db: {
            query: () => emptyQuery,
            delete: (id: string) => {
                ops.push({ id, kind: "delete" });

                return Promise.resolve();
            },
            insert: (table: string, document: Row) => {
                ops.push({ document, kind: "insert", table });

                return Promise.resolve("row_1");
            },
            deployKeys: facade("deployKeys"),
            organizations: facade("organizations"),
            patch: (id: string, patch: Row) => {
                ops.push({ id, kind: "patch", patch });

                return Promise.resolve();
            },
            platformUsage: facade("platformUsage"),
        },
        now,
        runMutation: () => Promise.resolve(undefined),
        runQuery: () => Promise.resolve(undefined),
    } as unknown as MutationCtx;

    return { ctx, ops };
};

/** A closed-period row (periodStart well below any plausible current period). */
const usageRow = (id: string, quantity: number, over: Row = {}): Row => {
    return { _id: id, kind: "requests", organizationId: "org_1", periodStart: 1000, quantity, ...over };
};

/** The quantity the survivor was patched to, for the convergence assertion. */
const patchedQuantity = (ops: Op[]): number => {
    const patch = ops.find((op) => op.kind === "patch");

    return patch?.kind === "patch" ? (patch.patch["quantity"] as number) : Number.NaN;
};

describe("usage.rollup", () => {
    it("collapses a group to one row carrying the group's total", async () => {
        const { ctx, ops } = makeCtx({ platformUsage: [usageRow("u1", 10), usageRow("u2", 5), usageRow("u3", 1)] });

        const result = await rollup.handler(ctx, {});

        expect(result).toStrictEqual({ compacted: 2 });
        expect(ops.filter((op) => op.kind === "delete").map((op) => op.id)).toStrictEqual(["u2", "u3"]);
        expect(ops.find((op) => op.kind === "patch")).toMatchObject({ id: "u1", patch: { quantity: 16 } });
    });

    /**
     * The invariant the whole design rests on. There is no multi-statement
     * transaction here, so a crash between the two writes must leave the ledger
     * under-counted, never over-counted — an extra row surviving beside an
     * already-summed survivor is a customer billed twice.
     */
    it("deletes every extra BEFORE writing the survivor's total", async () => {
        const { ctx, ops } = makeCtx({ platformUsage: [usageRow("u1", 10), usageRow("u2", 5)] });

        await rollup.handler(ctx, {});

        const lastDelete = ops.findLastIndex((op) => op.kind === "delete");
        const patchAt = ops.findIndex((op) => op.kind === "patch");

        expect(patchAt).toBeGreaterThan(lastDelete);
    });

    it("leaves a single-row group untouched", async () => {
        const { ctx, ops } = makeCtx({ platformUsage: [usageRow("u1", 10)] });

        await expect(rollup.handler(ctx, {})).resolves.toStrictEqual({ compacted: 0 });
        expect(ops).toStrictEqual([]);
    });

    it("groups by org, period AND meter — never sums across them", async () => {
        const { ctx, ops } = makeCtx({
            platformUsage: [
                usageRow("a1", 10),
                usageRow("a2", 5),
                usageRow("b1", 100, { kind: "cpuMs" }),
                usageRow("c1", 7, { organizationId: "org_2" }),
                usageRow("d1", 3, { periodStart: 2000 }),
            ],
        });

        await rollup.handler(ctx, {});

        // Only the two `org_1 / 1000 / requests` rows may merge.
        expect(ops.filter((op) => op.kind === "delete").map((op) => op.id)).toStrictEqual(["a2"]);
        expect(ops.filter((op) => op.kind === "patch")).toHaveLength(1);
    });

    /**
     * Convergence across ticks: a group split by the page boundary collapses in
     * stages, and the total after the second tick must equal the true total.
     */
    it("converges when a group is compacted over two ticks", async () => {
        const first = makeCtx({ platformUsage: [usageRow("u1", 10), usageRow("u2", 5)] });

        await rollup.handler(first.ctx, {});

        const survivorTotal = patchedQuantity(first.ops);
        const second = makeCtx({ platformUsage: [usageRow("u1", survivorTotal), usageRow("u4", 4)] });

        await rollup.handler(second.ctx, {});

        expect(patchedQuantity(second.ops)).toBe(19);
    });
});

const organization = (over: Row = {}): Row => {
    return { _id: "org_1", plan: "free", ...over };
};

describe("usage.enforceSpendCaps", () => {
    it("suspends an org over its cap and records why", async () => {
        const { ctx, ops } = makeCtx({
            organizations: [organization({ spendCapMinor: 1 })],
            platformUsage: [usageRow("u1", 10_000_000, { periodStart: Number.MAX_SAFE_INTEGER - 1 })],
        });

        await enforceSpendCaps.handler(ctx, {});

        expect(ops.find((op) => op.kind === "patch")).toMatchObject({ id: "org_1", patch: { suspendedReason: "spend-cap" } });
        expect(ops.find((op) => op.kind === "insert")).toMatchObject({ document: { action: "organization.suspend" }, table: "auditLog" });
    });

    it("does not re-suspend an org that is already suspended", async () => {
        const { ctx, ops } = makeCtx({
            organizations: [organization({ spendCapMinor: 1, suspendedAt: 1, suspendedReason: "spend-cap" })],
            platformUsage: [usageRow("u1", 10_000_000, { periodStart: Number.MAX_SAFE_INTEGER - 1 })],
        });

        await enforceSpendCaps.handler(ctx, {});

        expect(ops.filter((op) => op.kind === "patch" && "suspendedReason" in op.patch)).toStrictEqual([]);
    });

    /**
     * The gate that matters most on the recovery side: lifting a DUNNING
     * suspension would restore service to an org that has not paid.
     */
    it("lifts only its own suspensions, never a dunning one", async () => {
        const { ctx, ops } = makeCtx({
            organizations: [organization({ suspendedAt: 1, suspendedReason: "dunning" })],
            platformUsage: [],
        });

        await enforceSpendCaps.handler(ctx, {});

        expect(ops.filter((op) => op.kind === "patch")).toStrictEqual([]);
    });

    it("lifts a spend-cap suspension once usage is back under the cap", async () => {
        const { ctx, ops } = makeCtx({ organizations: [organization({ suspendedAt: 1, suspendedReason: "spend-cap" })], platformUsage: [] });

        await enforceSpendCaps.handler(ctx, {});

        expect(ops.find((op) => op.kind === "patch")).toMatchObject({ id: "org_1", patch: { suspendedAt: undefined, suspendedReason: undefined } });
    });
});

const ingestArgs = (over: Row = {}): Row => {
    return { deployKey: "production:org_1|secret", kind: "requests", organizationId: "org_1", periodStart: 1000, quantity: 5, ...over };
};

describe("usage.ingest", () => {
    /**
     * A real, authorized key — otherwise `authorizeDeployKey` throws first and the
     * quantity guard below is never reached. An earlier version of these tests
     * asserted only "it rejects", which passed against the WRONG rejection; the
     * message assertion is what exposed that.
     */
    const authorizedCtx = async (): Promise<MutationCtx> => {
        const key = "production:org_1|secret";
        const hashedKey = await hashDeployKey(key);

        return makeCtx({ deployKeys: [{ _id: "dk1", capability: "deploy", hashedKey, organizationId: "org_1" }] }).ctx;
    };

    /**
     * The deploy key is tenant-held, so this guard is what stops a tenant
     * deflating its own metered usage — and with it the spend-cap suspension and
     * the prepaid-overage debit, both of which sum this column directly.
     */
    it("rejects a negative quantity at the handler guard", async () => {
        const ctx = await authorizedCtx();

        await expect(ingest.handler(ctx, ingestArgs({ quantity: -1 }) as never)).rejects.toThrow("non-negative");
    });

    /**
     * `NaN` and `Infinity` never reach the guard — `v.number()` refuses them at the
     * input boundary. Asserted separately rather than lumped in with the negative
     * case, because "some layer rejected it" is exactly the vague assertion that
     * let an earlier version of this test pass against the wrong rejection.
     */
    it.each([
        [Number.NaN, "NaN"],
        [Number.POSITIVE_INFINITY, "Infinity"],
    ])("rejects %s at the input validator", async (quantity) => {
        const ctx = await authorizedCtx();

        await expect(ingest.handler(ctx, ingestArgs({ quantity }) as never)).rejects.toThrow("Expected number");
    });

    it("rejects a non-finite periodStart", async () => {
        const ctx = await authorizedCtx();

        await expect(ingest.handler(ctx, ingestArgs({ periodStart: Number.NaN }) as never)).rejects.toThrow("Expected number");
    });

    it("accepts an ordinary metered event", async () => {
        const ctx = await authorizedCtx();

        await expect(ingest.handler(ctx, ingestArgs() as never)).resolves.toBeDefined();
    });
});
