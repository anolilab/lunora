/**
 * The export and erasure paths, through the generated functions on the in-memory harness.
 *
 * A request opens through `privacyFor(appCtx(ctx), identity)`, the call the mutations make. The mutations
 * then start a Workflow instance through `ctx.workflows`, which the harness stubs, so the
 * workflow handlers run here directly. Their steps reach the database through the same
 * dispatcher a deployed workflow reaches with `ctx.run`.
 */
import { lunoraTest } from "@lunora/testing";
import type { WorkflowRunContext } from "@lunora/workflow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MutationCtx } from "../lunora/_generated/server.js";
import { listOpenPrivacyRequests, restorePrivacyErasures, retryPrivacyRequest } from "../lunora/admin";
import { privacyFor, privacyWorkflows } from "../lunora/privacy";
import { cancelRequest, downloadUrl, myRequests, privacyPort, requestErasure } from "../lunora/requests";
import schema from "../lunora/schema";
import { addTask, myTasks } from "../lunora/tasks";
import type { RunHooks } from "./workflow-context";
import { tombstoneNamespace, workflowContext } from "./workflow-context";

type Harness = ReturnType<typeof lunoraTest>;
type Context = WorkflowRunContext<{ requestId: string }>;

/**
 * The harness's context lacks the `orm` surface codegen adds to this app's `MutationCtx`.
 * The privacy code never reads `orm`, so the cast only bridges that gap.
 */
const appCtx = (ctx: unknown): MutationCtx => ctx as MutationCtx;

const DOWNLOAD_PATH = /\/privacy\/files\//u;
const NO_WORKFLOWS = /ctx\.workflows/u;

/**
 * A workflow context over the harness. `run` calls the app's internal `privacyPort` mutation,
 * as a deployed workflow does through `ctx.run`.
 */
const contextFor = (t: Harness, requestId: string, tombstones: ReturnType<typeof tombstoneNamespace>, hooks: RunHooks = {}): Context =>
    workflowContext(
        {
            env: { PRIVACY_TOMBSTONES: tombstones },
            params: { requestId },
            run: async (_reference, args) => t.run(async (ctx) => appCtx(ctx).runMutation(privacyPort, args)),
        },
        hooks,
    );

/**
 * Opens an erasure the way `requestErasure` does, from a sign-in made just now. The mutation
 * then starts the workflow, which the harness stubs, so the test calls the package directly.
 * The session check stays in the mutation, and a test below covers it.
 */
const openErasure = async (t: Harness, subjectId: string) =>
    t.run(async (ctx) => privacyFor(appCtx(ctx), { sessionAgeMs: 60_000, subjectId }).requestErasure());

const SUBJECT = { userId: "u1" };
const OTHER = { userId: "u2" };

const titlesOf = (rows: ReadonlyArray<{ title: string }>): string[] => rows.map((row) => row.title).toSorted((a, b) => a.localeCompare(b));

describe("privacy example", () => {
    let t: Harness;
    let tombstones: ReturnType<typeof tombstoneNamespace>;

    beforeEach(async () => {
        t = lunoraTest(schema);
        tombstones = tombstoneNamespace();

        await t.withIdentity(SUBJECT).mutation(addTask, { title: "book flights" });
        await t.withIdentity(SUBJECT).mutation(addTask, { title: "renew passport" });
        await t.withIdentity(OTHER).mutation(addTask, { title: "not yours" });
    });

    afterEach(() => {
        t.close();
    });

    it("keeps the restore action internal, so no client can start a re-erasure", () => {
        expect.assertions(1);

        expect(restorePrivacyErasures).toMatchObject({ visibility: "internal" });
    });

    it("exports the subject's own rows and leaves other subjects out", async () => {
        expect.assertions(4);

        const request = await t.run(async (ctx) => privacyFor(appCtx(ctx), { sessionAgeMs: 60_000, subjectId: SUBJECT.userId }).requestExport());

        await privacyWorkflows.exportHandler(contextFor(t, request.id, tombstones));

        const part = await t.run(async (ctx) =>
            appCtx(ctx)
                .db.query("exportFiles")
                .withIndex("byRequestAndName", (q) => q.eq("requestId", request.id))
                .collect()
                .then((rows) => rows.find((row) => row.name.endsWith("/parts/tasks.json"))),
        );
        const stored = JSON.parse(part?.body ?? "{}") as { tables: { tasks: { title: string }[] } };

        expect(titlesOf(stored.tables.tasks)).toStrictEqual(["book flights", "renew passport"]);

        const archive = await t.run(async (ctx) =>
            appCtx(ctx)
                .db.query("exportFiles")
                .withIndex("byRequestAndName", (q) => q.eq("requestId", request.id))
                .collect()
                .then((rows) => rows.find((row) => row.name.endsWith("/export.zip"))),
        );

        expect(archive?.encoding).toBe("base64");

        const requestRow = await t.run(async (ctx) =>
            appCtx(ctx)
                .db.query("privacy_requests")
                .withIndex("byRequestId", (q) => q.eq("requestId", request.id))
                .first(),
        );

        expect(requestRow?.status).toBe("ready");
        await expect(t.withIdentity(SUBJECT).query(myRequests, {})).resolves.toHaveLength(1);
    });

    it("gives the subject a download link for their export, and refuses anyone else", async () => {
        expect.assertions(2);

        const request = await t.run(async (ctx) => privacyFor(appCtx(ctx), { sessionAgeMs: 60_000, subjectId: SUBJECT.userId }).requestExport());

        await privacyWorkflows.exportHandler(contextFor(t, request.id, tombstones));

        await expect(t.withIdentity(SUBJECT).query(downloadUrl, { requestId: request.id })).resolves.toMatch(DOWNLOAD_PATH);
        await expect(t.withIdentity(OTHER).query(downloadUrl, { requestId: request.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("erases the subject's rows through the erasure workflow, and only theirs", async () => {
        expect.assertions(5);

        const request = await openErasure(t, SUBJECT.userId);

        await expect(t.withIdentity(SUBJECT).query(myTasks, {})).resolves.toHaveLength(2);

        await privacyWorkflows.erasureHandler(contextFor(t, request.id, tombstones));

        await expect(t.withIdentity(SUBJECT).query(myTasks, {})).resolves.toStrictEqual([]);
        await expect(t.withIdentity(OTHER).query(myTasks, {})).resolves.toHaveLength(1);

        const requestRow = await t.run(async (ctx) =>
            appCtx(ctx)
                .db.query("privacy_requests")
                .withIndex("byRequestId", (q) => q.eq("requestId", request.id))
                .first(),
        );

        expect(requestRow?.status).toBe("completed");
        // The tombstone goes to its own store, outside the shard a restore rolls back.
        expect(tombstones.keys.size).toBe(1);
    });

    it("leaves the rows alone when the subject cancels during the grace", async () => {
        expect.assertions(3);

        const request = await openErasure(t, SUBJECT.userId);
        const steps: string[] = [];

        // The workflow loads the request in its grace, and the subject cancels while it sleeps, so the
        // run sleeps the grace out and its start step finds the cancel.
        await privacyWorkflows.erasureHandler(
            contextFor(t, request.id, tombstones, {
                duringSleep: async () => {
                    await t.withIdentity(SUBJECT).mutation(cancelRequest, { requestId: request.id });
                },
                steps,
            }),
        );

        expect(steps).toStrictEqual(["load", "sleep:grace", "start"]);
        await expect(t.withIdentity(SUBJECT).query(myTasks, {})).resolves.toHaveLength(2);
        await expect(t.withIdentity(OTHER).mutation(cancelRequest, { requestId: request.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("erases a restored subject again through the restore workflow, and leaves the others", async () => {
        expect.assertions(3);

        const request = await openErasure(t, SUBJECT.userId);

        await privacyWorkflows.erasureHandler(contextFor(t, request.id, tombstones));

        // A point-in-time restore brings the subject's rows back; the tombstone store keeps its keys.
        await t.withIdentity(SUBJECT).mutation(addTask, { title: "book flights" });

        const reerased = await privacyWorkflows.restoreHandler(
            workflowContext({
                env: { PRIVACY_TOMBSTONES: tombstones },
                params: { restoredSubjectIds: [SUBJECT.userId, OTHER.userId] },
                run: async (_reference, args) => t.run(async (ctx) => appCtx(ctx).runMutation(privacyPort, args)),
            }),
        );

        expect(reerased).toStrictEqual([SUBJECT.userId]);
        await expect(t.withIdentity(SUBJECT).query(myTasks, {})).resolves.toStrictEqual([]);
        await expect(t.withIdentity(OTHER).query(myTasks, {})).resolves.toHaveLength(1);
    });

    it("refuses an erasure from a session with no issued-at claim", async () => {
        expect.assertions(1);

        await expect(t.withIdentity(SUBJECT).mutation(requestErasure, {})).rejects.toMatchObject({ code: "PRIVACY_SESSION_NOT_FRESH" });
    });

    describe("operator functions for the Studio page", () => {
        // Internal functions are refused at the client boundary, so the tests reach them as server code does.
        const listOpen = async () => t.run(async (ctx) => appCtx(ctx).runQuery(listOpenPrivacyRequests, {}));
        const retry = async (requestId: string) => t.run(async (ctx) => appCtx(ctx).runMutation(retryPrivacyRequest, { requestId }));

        /** Marks a request failed, as a run that threw would. */
        const fail = async (requestId: string): Promise<void> => {
            await t.run(async (ctx) => {
                const row = await appCtx(ctx)
                    .db.query("privacy_requests")
                    .withIndex("byRequestId", (q) => q.eq("requestId", requestId))
                    .first();

                await appCtx(ctx).db.patch(row!._id, { status: "failed" });
            });
        };

        it("lists the open requests in the shape the Studio's page reads", async () => {
            expect.assertions(1);

            const request = await t.run(async (ctx) => privacyFor(appCtx(ctx), { sessionAgeMs: 60_000, subjectId: SUBJECT.userId }).requestExport());

            await expect(listOpen()).resolves.toStrictEqual([
                {
                    dueAt: request.dueAt.getTime(),
                    extendedDueAt: null,
                    id: request.id,
                    receivedAt: request.receivedAt.getTime(),
                    status: "received",
                    subjectId: SUBJECT.userId,
                    type: "export",
                },
            ]);
        });

        it("re-runs a failed export through the package's retry", async () => {
            expect.assertions(2);

            const request = await t.run(async (ctx) => privacyFor(appCtx(ctx), { sessionAgeMs: 60_000, subjectId: SUBJECT.userId }).requestExport());

            await fail(request.id);

            await expect(retry(request.id)).resolves.toStrictEqual({ requestId: request.id, status: "ready" });
            await expect(t.withIdentity(SUBJECT).query(downloadUrl, { requestId: request.id })).resolves.toMatch(DOWNLOAD_PATH);
        });

        it("restarts a failed erasure's workflow rather than erasing without a tombstone", async () => {
            expect.assertions(2);

            const request = await openErasure(t, SUBJECT.userId);

            await fail(request.id);

            // The harness has no `ctx.workflows`, so reaching the workflow start is where the call stops here.
            await expect(retry(request.id)).rejects.toThrow(NO_WORKFLOWS);
            // Nothing was erased inline: the restarted workflow does that, and writes the tombstone.
            await expect(t.withIdentity(SUBJECT).query(myTasks, {})).resolves.toHaveLength(2);
        });

        it("refuses to retry a request that has not failed", async () => {
            expect.assertions(1);

            const request = await openErasure(t, SUBJECT.userId);

            await expect(retry(request.id)).rejects.toMatchObject({ code: "UNPROCESSABLE" });
        });
    });
});
