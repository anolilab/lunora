import { describe, expect, it } from "vitest";

import { rollup, summary } from "../lunora/usage";
import { buildOverageReconcileData } from "../src/billing/reconcile";
import { isBillableUsage } from "../src/billing/usage";
import { MAX_REPORT_AGE_MS, periodStartOf, recordBoxReport } from "../src/boxes/usage";
import fakeControlPlaneDb from "./_helpers/fake-control-plane-db";
import { makeCtx, owner } from "./_helpers/fake-ctx";
import { boxKey, boxRow, fakeState, handshake, TestBoxSession } from "./support/box-session-fakes";
import { memoryStore } from "./support/memory-store";

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const BOX = { _id: "box_1", organizationId: "org_1" };

/** One project on box_1 with a live `web`, one on another box with a live `api`. */
const seeded = () =>
    memoryStore({
        aliasOwnership: [
            { _id: "own_web", alias: "web", projectId: "proj_web" },
            { _id: "own_api", alias: "api", projectId: "proj_api" },
        ],
        deployments: [
            { _id: "dep_web_old", alias: "web", projectId: "proj_web", status: "superseded" },
            { _id: "dep_web", alias: "web", projectId: "proj_web", status: "live" },
            { _id: "dep_api", alias: "api", projectId: "proj_api", status: "live" },
        ],
        platformUsage: [],
        projects: [
            { _id: "proj_web", boxId: "box_1", organizationId: "org_1" },
            { _id: "proj_api", boxId: "box_2", organizationId: "org_1" },
        ],
    });

const report = (windowStart: number, perAlias: { alias: string; errors?: number; requests: number }[]) => {
    return {
        perAlias: perAlias.map((entry) => {
            return { errors: 0, ...entry };
        }),
        type: "report" as const,
        windowEnd: windowStart + MINUTE,
        windowStart,
    };
};

describe("recording a box's usage report", () => {
    it("writes one requests row per alias of this box, on its live deployment, tagged with the box and window", async () => {
        const store = seeded();
        const windowStart = NOW - 2 * MINUTE;

        await expect(
            recordBoxReport(
                store,
                BOX,
                report(windowStart, [
                    { alias: "web", requests: 42 },
                    { alias: "api", requests: 7 },
                    { alias: "ghost", requests: 1 },
                    { alias: "web-idle", requests: 0 },
                ]),
                NOW,
            ),
        ).resolves.toStrictEqual({ recorded: 1 });
        expect(store.tables["platformUsage"]).toStrictEqual([
            {
                _id: "platformUsage_1",
                boxId: "box_1",
                createdAt: NOW,
                deploymentId: "dep_web",
                kind: "requests",
                organizationId: "org_1",
                periodStart: periodStartOf(windowStart),
                quantity: 42,
                windowStart,
            },
        ]);
    });

    it("never double-counts a replayed report", async () => {
        const store = seeded();
        const sent = report(NOW - MINUTE, [{ alias: "web", requests: 10 }]);

        await recordBoxReport(store, BOX, sent, NOW);

        await expect(recordBoxReport(store, BOX, sent, NOW + MINUTE)).resolves.toStrictEqual({ dropped: "duplicate" });
        await expect(recordBoxReport(store, BOX, { ...sent, perAlias: [{ alias: "web", errors: 0, requests: 99 }] }, NOW)).resolves.toStrictEqual({
            dropped: "duplicate",
        });
        expect(store.tables["platformUsage"]?.map((row) => row["quantity"])).toStrictEqual([10]);
    });

    it.each([
        ["a window over an hour long", { ...report(NOW - 2 * 60 * MINUTE, []), windowEnd: NOW }],
        ["a window older than a day", report(NOW - MAX_REPORT_AGE_MS - MINUTE, [])],
        ["a window ending in the future", report(NOW + 10 * MINUTE, [])],
    ])("drops %s", async (_name, sent) => {
        const store = seeded();

        await expect(recordBoxReport(store, BOX, { ...sent, perAlias: [{ alias: "web", errors: 0, requests: 5 }] }, NOW)).resolves.toStrictEqual({
            dropped: "out-of-range",
        });
        expect(store.tables["platformUsage"]).toStrictEqual([]);
    });

    it("counts nothing for an alias whose project is in another organization", async () => {
        const store = seeded();

        await expect(
            recordBoxReport(store, { _id: "box_1", organizationId: "org_2" }, report(NOW - MINUTE, [{ alias: "web", requests: 3 }]), NOW),
        ).resolves.toStrictEqual({
            recorded: 0,
        });
    });
});

describe("reports over the box's session", () => {
    it("records a minute-aligned report frame once, and ignores an unaligned one", async () => {
        const key = await boxKey();
        const store = seeded();

        store.tables["boxes"] = [boxRow(key)];
        store.tables["domains"] = [];

        const state = fakeState();
        const session = new TestBoxSession(state, store);
        const socket = await handshake(session, state, key, "box_1");
        const windowStart = Math.floor(Date.now() / MINUTE) * MINUTE - MINUTE;
        const frame = (start: number) => JSON.stringify(report(start, [{ alias: "web", requests: 4 }]));

        await session.webSocketMessage(socket, frame(windowStart));
        await session.webSocketMessage(socket, frame(windowStart));
        await session.webSocketMessage(socket, frame(windowStart + 1));

        expect(store.tables["platformUsage"]?.map((row) => [row["windowStart"], row["quantity"]])).toStrictEqual([[windowStart, 4]]);
        expect(socket.closedWith).toBeUndefined();
    });
});

describe("box usage is never billed (plan 458 D12)", () => {
    const billable = { _id: "u_bill", createdAt: NOW, kind: "requests", organizationId: "org_1", periodStart: periodStartOf(NOW), quantity: 100 };
    const boxed = { ...billable, _id: "u_box", boxId: "box_1", quantity: 1_000_000_000, windowStart: NOW - MINUTE };

    it("tells box rows apart, NULL included", () => {
        expect(isBillableUsage({})).toBe(true);
        expect(isBillableUsage({ boxId: null })).toBe(true);
        expect(isBillableUsage({ boxId: "box_1" })).toBe(false);
    });

    /** A ctx whose `platformUsage` reads answer `rows` as one finished page, whatever the filter. */
    const usageCtx = (rows: Record<string, unknown>[]) => {
        const { ctx, ops } = makeCtx({ members: [owner("org_1")] });
        const database = ctx.db as unknown as Record<string, unknown>;

        database["platformUsage"] = { findMany: () => Promise.resolve({ continueCursor: null, isDone: true, page: rows }) };

        return { ctx, ops };
    };

    it("leaves box rows out of the period summary", async () => {
        const { ctx } = usageCtx([billable, boxed]);

        await expect(summary.handler(ctx, { organizationId: "org_1" as never, periodStart: periodStartOf(NOW) })).resolves.toMatchObject({ requests: 100 });
    });

    it("leaves box rows out of the overage reconciliation", async () => {
        const data = await buildOverageReconcileData(
            fakeControlPlaneDb({ organizations: [{ _id: "org_1", plan: "free" }], overageDebits: [], platformUsage: [billable, boxed] }),
            periodStartOf(NOW),
        );

        expect(data.inputs[0]?.usage).toStrictEqual({ cpuMs: 0, requests: 100 });
    });

    it("compacts box rows apart from billable ones", async () => {
        const closed = periodStartOf(NOW) - 1;
        const rows = [
            { ...billable, _id: "a", periodStart: closed },
            { ...billable, _id: "b", periodStart: closed },
            { ...boxed, _id: "c", periodStart: closed },
            { ...boxed, _id: "d", periodStart: closed },
        ];
        const { ctx, ops } = usageCtx(rows);

        await rollup.handler(ctx, {});

        expect(ops.filter((op) => op.kind === "patch")).toStrictEqual([
            { id: "a", kind: "patch", patch: { quantity: 200 } },
            { id: "c", kind: "patch", patch: { quantity: 2_000_000_000 } },
        ]);
    });
});
