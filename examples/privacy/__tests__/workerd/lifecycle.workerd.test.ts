/**
 * The request lifecycle over a real Durable Object's SQLite.
 *
 * The node suite (`__tests__/privacy.test.ts`) runs these ports on `node:sqlite`, which does not
 * model workerd's SQLite. This suite runs the same lifecycle — open an export, run it, download it;
 * open an erasure, run it, check the subject's rows are gone and the other subject's remain; cancel
 * during the grace — with the app's own functions and workflow handlers, over the Durable Object's
 * storage.
 *
 * Each test gets a fresh Durable Object, so its SQLite starts empty.
 */
import { createInProcessRuntime, resolveInProcessIdentity } from "@lunora/server/in-process";
import type { WorkflowRunContext } from "@lunora/workflow";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { MutationCtx } from "../../lunora/_generated/server.js";
import { privacyAs, privacyWorkflows } from "../../lunora/privacy";
import type { CallIdentity } from "../../lunora/privacy-ports";
import { dispatchPort } from "../../lunora/privacy-ports";
import schema from "../../lunora/schema";

type Context = WorkflowRunContext<{ requestId: string }>;
type Runtime = ReturnType<typeof createInProcessRuntime>;
type Database = ReturnType<Runtime["createWriters"]>["database"];

const DOWNLOAD_PATH = /\/privacy\/files\//u;
const SUBJECT = "u1";
const OTHER = "u2";

const identity = (subjectId: string): CallIdentity => {
    return { sessionAgeMs: 60_000, subjectId };
};

/**
 * The app's mutation context over the shard's writer. The ports read `ctx.db` only; the
 * workflows are started by the test, as the node suite does.
 */
const appCtx = (db: Database): MutationCtx => ({ db }) as unknown as MutationCtx;

/**
 * A workflow context over the shard. `run` is the dispatcher the internal `privacyPort` mutation
 * runs. `step.do` runs its callback at once, since the test has no durable replay.
 */
const workflowContext = (db: Database, requestId: string): Context => {
    const run = async (_reference: unknown, args: { method: string; payload: string }) => dispatchPort(appCtx(db), args.method, args.payload);

    const step = {
        do: async (_name: string, callback: () => Promise<unknown>) => callback(),
        sleepUntil: async () => undefined,
    };

    return { params: { requestId }, run, step } as unknown as Context;
};

/** Runs `body` inside a fresh Durable Object, with the app's runtime built over its SQLite. */
const withShard = async <T>(body: (db: Database) => Promise<T>): Promise<T> => {
    const stub = env.PRIVACY.get(env.PRIVACY.newUniqueId());

    return runInDurableObject(stub, async (_instance, state) => {
        // `createInProcessRuntime` runs the schema's migrations, as the shard does when it starts.
        const runtime = createInProcessRuntime(schema, {
            sql: state.storage.sql as unknown as Parameters<typeof createInProcessRuntime>[1]["sql"],
        });

        return body(runtime.createWriters(resolveInProcessIdentity(null)).database);
    });
};

const seed = async (db: Database): Promise<void> => {
    await db.insert("tasks", { createdAt: 1, done: false, title: "book flights", userId: SUBJECT });
    await db.insert("tasks", { createdAt: 2, done: false, title: "renew passport", userId: SUBJECT });
    await db.insert("tasks", { createdAt: 3, done: false, title: "not yours", userId: OTHER });
};

/** The task titles the shard holds for one user, sorted. */
const tasksOf = async (db: Database, userId: string): Promise<string[]> => {
    const rows = await db.query("tasks").collect();

    return rows
        .filter((row) => row.userId === userId)
        .map((row) => String(row.title))
        .toSorted((a, b) => a.localeCompare(b));
};

const requestRow = async (db: Database, requestId: string): Promise<undefined | { status: string }> => {
    const rows = await db.query("privacy_requests").collect();

    return rows.find((row) => row.requestId === requestId) as undefined | { status: string };
};

describe("privacy example lifecycle (workerd)", () => {
    it("exports the subject's rows, stores the archive, and links a download", async () => {
        expect.assertions(6);

        await withShard(async (db) => {
            await seed(db);

            const request = await privacyAs(appCtx(db), identity(SUBJECT)).requestExport();

            await privacyWorkflows.exportHandler(workflowContext(db, request.id));

            const rows = await db.query("exportFiles").collect();
            const part = rows.find((row) => row.requestId === request.id && row.name === "parts/tasks.json");
            const stored = JSON.parse((part?.body as string | undefined) ?? "{}") as { tables: { tasks: { title: string }[] } };

            expect(stored.tables.tasks.map((row) => row.title).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["book flights", "renew passport"]);

            const archive = rows.find((row) => row.requestId === request.id && row.name === "export.zip");

            expect(archive?.encoding).toBe("base64");

            const ready = await requestRow(db, request.id);

            expect(ready?.status).toBe("ready");

            await expect(privacyAs(appCtx(db), identity(SUBJECT)).downloadUrl({ requestId: request.id })).resolves.toMatch(DOWNLOAD_PATH);
            await expect(privacyAs(appCtx(db), identity(OTHER)).downloadUrl({ requestId: request.id })).rejects.toMatchObject({
                code: "NOT_FOUND",
            });
            await expect(tasksOf(db, OTHER)).resolves.toStrictEqual(["not yours"]);
        });
    });

    it("erases the subject's rows through the erasure workflow, and only theirs", async () => {
        expect.assertions(4);

        await withShard(async (db) => {
            await seed(db);

            const request = await privacyAs(appCtx(db), identity(SUBJECT)).requestErasure();

            await expect(tasksOf(db, SUBJECT)).resolves.toHaveLength(2);

            await privacyWorkflows.erasureHandler(workflowContext(db, request.id));

            await expect(tasksOf(db, SUBJECT)).resolves.toStrictEqual([]);
            await expect(tasksOf(db, OTHER)).resolves.toStrictEqual(["not yours"]);

            const completed = await requestRow(db, request.id);

            expect(completed?.status).toBe("completed");
        });
    });

    it("leaves the rows alone when the subject cancels during the grace", async () => {
        expect.assertions(3);

        await withShard(async (db) => {
            await seed(db);

            const request = await privacyAs(appCtx(db), identity(SUBJECT)).requestErasure();

            await privacyAs(appCtx(db), identity(SUBJECT)).cancelRequest({ requestId: request.id });
            await privacyWorkflows.erasureHandler(workflowContext(db, request.id));

            await expect(tasksOf(db, SUBJECT)).resolves.toHaveLength(2);
            await expect(tasksOf(db, OTHER)).resolves.toStrictEqual(["not yours"]);

            const cancelled = await requestRow(db, request.id);

            expect(cancelled?.status).toBe("cancelled");
        });
    });
});
