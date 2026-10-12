/**
 * The export and erasure paths, through the generated functions on the in-memory harness.
 *
 * A request opens through `privacyAs(appCtx(ctx), identity)`, the call the mutations make. The mutations
 * then start a Workflow instance through `ctx.workflows`, which the harness stubs, so the
 * workflow handlers run here directly. Their steps reach the database through the same
 * dispatcher a deployed workflow reaches with `ctx.run`.
 */
import { lunoraTest } from "@lunora/testing";
import type { WorkflowRunContext } from "@lunora/workflow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MutationCtx } from "../lunora/_generated/server.js";
import { privacyAs, privacyWorkflows } from "../lunora/privacy";
import { dispatchPort } from "../lunora/privacy-ports";
import { cancelRequest, downloadUrl, myRequests, requestErasure } from "../lunora/requests";
import schema from "../lunora/schema";
import { addTask, myTasks } from "../lunora/tasks";

type Harness = ReturnType<typeof lunoraTest>;
type Context = WorkflowRunContext<{ requestId: string }>;

/**
 * The harness's context lacks the `orm` surface codegen adds to this app's `MutationCtx`.
 * The privacy code never reads `orm`, so the cast only bridges that gap.
 */
const appCtx = (ctx: unknown): MutationCtx => ctx as MutationCtx;

const DOWNLOAD_PATH = /\/privacy\/files\//u;

/** An in-memory stand-in for the `PRIVACY_TOMBSTONES` Durable Object. The workerd suite runs the real one. */
const tombstoneNamespace = () => {
    const keys = new Map<string, number>();
    const stub = {
        add: async (key: string, erasedAt: number) => {
            keys.set(key, erasedAt);
        },
        keys: async () => [...keys.keys()],
    };

    return { get: () => stub, idFromName: (name: string) => name, keys };
};

/** What a test can observe of, and do during, a workflow run. */
interface RunHooks {
    /** Runs while the workflow sleeps through the grace window, as a subject's cancel would. */
    readonly duringSleep?: () => Promise<void>;
    /** Every step name the run reached, in order. */
    readonly steps?: string[];
}

/**
 * A workflow context over the harness. `run` is the dispatcher the internal `privacyPort`
 * mutation runs. `step.do` runs its callback at once, since the test has no durable replay.
 */
const workflowContext = (t: Harness, requestId: string, tombstones: ReturnType<typeof tombstoneNamespace>, hooks: RunHooks = {}): Context => {
    const run = async (_reference: unknown, args: { method: string; payload: string }) =>
        t.run(async (ctx) => dispatchPort(appCtx(ctx), args.method, args.payload));

    const step = {
        do: async (name: string, callback: () => Promise<unknown>) => {
            hooks.steps?.push(name);

            return callback();
        },
        sleepUntil: async () => {
            await hooks.duringSleep?.();
        },
    };

    // The harness has no durable runner, so these doubles stand in for the platform's context.
    return { env: { PRIVACY_TOMBSTONES: tombstones }, params: { requestId }, run, step } as unknown as Context;
};

/**
 * Opens an erasure the way `requestErasure` does, from a sign-in made just now. The mutation
 * then starts the workflow, which the harness stubs, so the test calls the package directly.
 * The session check stays in the mutation, and a test below covers it.
 */
const openErasure = async (t: Harness, subjectId: string) => t.run(async (ctx) => privacyAs(appCtx(ctx), { sessionAgeMs: 60_000, subjectId }).requestErasure());

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

    it("exports the subject's own rows and leaves other subjects out", async () => {
        expect.assertions(4);

        const request = await t.run(async (ctx) => privacyAs(appCtx(ctx), { sessionAgeMs: 60_000, subjectId: SUBJECT.userId }).requestExport());

        await privacyWorkflows.exportHandler(workflowContext(t, request.id, tombstones));

        const part = await t.run(async (ctx) =>
            appCtx(ctx)
                .db.query("exportFiles")
                .withIndex("byRequestAndName", (q) => q.eq("requestId", request.id).eq("name", "parts/tasks.json"))
                .first(),
        );
        const stored = JSON.parse(part?.body ?? "{}") as { tables: { tasks: { title: string }[] } };

        expect(titlesOf(stored.tables.tasks)).toStrictEqual(["book flights", "renew passport"]);

        const archive = await t.run(async (ctx) =>
            appCtx(ctx)
                .db.query("exportFiles")
                .withIndex("byRequestAndName", (q) => q.eq("requestId", request.id).eq("name", "export.zip"))
                .first(),
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

        const request = await t.run(async (ctx) => privacyAs(appCtx(ctx), { sessionAgeMs: 60_000, subjectId: SUBJECT.userId }).requestExport());

        await privacyWorkflows.exportHandler(workflowContext(t, request.id, tombstones));

        await expect(t.withIdentity(SUBJECT).query(downloadUrl, { requestId: request.id })).resolves.toMatch(DOWNLOAD_PATH);
        await expect(t.withIdentity(OTHER).query(downloadUrl, { requestId: request.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("erases the subject's rows through the erasure workflow, and only theirs", async () => {
        expect.assertions(5);

        const request = await openErasure(t, SUBJECT.userId);

        await expect(t.withIdentity(SUBJECT).query(myTasks, {})).resolves.toHaveLength(2);

        await privacyWorkflows.erasureHandler(workflowContext(t, request.id, tombstones));

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

        // The workflow loads the request in its grace, and the subject cancels while it sleeps.
        await privacyWorkflows.erasureHandler(
            workflowContext(t, request.id, tombstones, {
                duringSleep: async () => {
                    await t.withIdentity(SUBJECT).mutation(cancelRequest, { requestId: request.id });
                },
                steps,
            }),
        );

        expect(steps).toStrictEqual(["load", "recheck"]);
        await expect(t.withIdentity(SUBJECT).query(myTasks, {})).resolves.toHaveLength(2);
        await expect(t.withIdentity(OTHER).mutation(cancelRequest, { requestId: request.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("refuses an erasure from a session with no issued-at claim", async () => {
        expect.assertions(1);

        await expect(t.withIdentity(SUBJECT).mutation(requestErasure, {})).rejects.toMatchObject({ code: "PRIVACY_SESSION_NOT_FRESH" });
    });
});
