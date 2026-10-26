/**
 * A retention rule on real rows: erasure keeps an invoice under `de.voucher` instead of deleting it, and
 * the housekeeping sweep purges the kept row once its period has ended. Runs on the in-memory harness;
 * `workflow.workerd.test.ts` runs the same two steps over a Durable Object's SQLite.
 */
import { lunoraTest } from "@lunora/testing";
import type { WorkflowRunContext } from "@lunora/workflow";
import { beforeEach, describe, expect, it } from "vitest";

import type { MutationCtx } from "../lunora/_generated/server.js";
import { restoredSubjectIdsOf } from "../lunora/admin";
import { privacyFor, privacyWorkflows } from "../lunora/privacy";
import { privacyPort } from "../lunora/requests";
import schema from "../lunora/schema";
import { addTask } from "../lunora/tasks";
import { d1Double, seedSignIn } from "./d1-double";
import type { RunHooks } from "./workflow-context";
import { tombstoneNamespace, workflowContext } from "./workflow-context";

type Harness = ReturnType<typeof lunoraTest>;
type Context = WorkflowRunContext<{ requestId: string }>;

/** The harness's context lacks the `orm` surface codegen adds; the privacy code never reads it. */
const appCtx = (ctx: unknown): MutationCtx => ctx as MutationCtx;

/** A fixed issue date, so the retention periods do not depend on the day the suite runs. */
const ISSUED = Date.UTC(2026, 2, 1);
/** An archive date long past, and one far in the future, so the purge does not depend on the wall clock either. */
const PAST = Date.UTC(2000, 0, 1);
const FUTURE = Date.UTC(2100, 0, 1);
const SUBJECT = { userId: "u1" };
const OTHER = { userId: "u2" };

/** The D1 double each test seeds and reads. Set in `beforeEach`, and read by the context helper below. */
let d1: ReturnType<typeof d1Double>;

/** A workflow context whose `run` calls the app's internal `privacyPort`, as a deployed workflow does. */
const contextFor = (t: Harness, requestId: string, tombstones: ReturnType<typeof tombstoneNamespace>, hooks: RunHooks = {}): Context =>
    workflowContext(
        {
            env: { DB: d1.db, PRIVACY_TOMBSTONES: tombstones },
            params: { requestId },
            run: async (_reference, args) => t.run(async (ctx) => appCtx(ctx).runMutation(privacyPort, args)),
        },
        hooks,
    );

const archivedRows = async (t: Harness) => t.run(async (ctx) => appCtx(ctx).db.query("privacy_archive").collect());

describe("retention on erasure and the sweep", () => {
    let t: Harness;
    let tombstones: ReturnType<typeof tombstoneNamespace>;

    beforeEach(async () => {
        t = lunoraTest(schema);
        tombstones = tombstoneNamespace();
        d1 = d1Double();
        seedSignIn(d1.tables, SUBJECT.userId);
        seedSignIn(d1.tables, OTHER.userId);

        await t.run(async (ctx) => {
            const database = appCtx(ctx).db;

            await database.insert("invoices", { amount: 4200, issuedAt: ISSUED, number: "INV-1", userId: SUBJECT.userId });
            await database.insert("invoices", { amount: 900, issuedAt: ISSUED, number: "INV-2", userId: OTHER.userId });
        });
        await t.withIdentity(SUBJECT).mutation(addTask, { title: "book flights" });
    });

    it("keeps the subject's invoice in the archive under its retention period, and erases the rest", async () => {
        expect.assertions(4);

        const request = await t.run(async (ctx) => privacyFor(appCtx(ctx), { sessionAgeMs: 60_000, subjectId: SUBJECT.userId }).requestErasure());

        await privacyWorkflows.erasureHandler(contextFor(t, request.id, tombstones));

        const live = await t.run(async (ctx) => appCtx(ctx).db.query("invoices").collect());

        expect(live.map((row) => row.number)).toStrictEqual(["INV-2"]);

        const [kept] = await archivedRows(t);

        expect(kept).toMatchObject({ datasetId: "billing", subjectId: SUBJECT.userId, table: "invoices" });
        expect(kept?.retainUntil).toBeGreaterThan(ISSUED);
        expect(kept?.row).toContain("INV-1");
    });

    it("purges an archived invoice whose period has ended when a restore brings it back", async () => {
        expect.assertions(1);

        await t.run(async (ctx) => {
            await appCtx(ctx).db.insert("privacy_archive", { datasetId: "billing", retainUntil: PAST, row: "{}", subjectId: "u9", table: "invoices" });
        });

        await privacyWorkflows.restoreHandler(
            workflowContext({
                env: { DB: d1.db, PRIVACY_TOMBSTONES: tombstones },
                params: { restoredSubjectIds: [] },
                run: async (_reference, args) => t.run(async (ctx) => appCtx(ctx).runMutation(privacyPort, args)),
            }),
        );

        await expect(archivedRows(t)).resolves.toStrictEqual([]);
    });

    it("lists a subject with only invoices among the subjects a restore re-erases", async () => {
        expect.assertions(2);

        const before = await t.run(async (ctx) => restoredSubjectIdsOf(appCtx(ctx)));

        await t.run(async (ctx) => appCtx(ctx).db.insert("invoices", { amount: 1200, issuedAt: ISSUED, number: "INV-3", userId: "u3" }));

        const after = await t.run(async (ctx) => restoredSubjectIdsOf(appCtx(ctx)));

        expect(before.toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["u1", "u2"]);
        expect(after.toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["u1", "u2", "u3"]);
    });

    it("purges a kept invoice once its period has ended, and keeps the rest", async () => {
        expect.assertions(3);

        await t.run(async (ctx) => {
            const database = appCtx(ctx).db;

            await database.insert("privacy_archive", {
                datasetId: "billing",
                retainUntil: PAST,
                row: "{}",
                subjectId: SUBJECT.userId,
                table: "invoices",
            });
            await database.insert("privacy_archive", {
                datasetId: "billing",
                retainUntil: FUTURE,
                row: "{}",
                subjectId: SUBJECT.userId,
                table: "invoices",
            });
        });

        const swept = await t.run(async (ctx) => privacyFor(appCtx(ctx)).admin.sweep());

        expect(swept.purged).toBe(1);

        const remaining = await archivedRows(t);

        expect(remaining).toHaveLength(1);
        expect(remaining[0]?.retainUntil).toBe(FUTURE);
    });
});
