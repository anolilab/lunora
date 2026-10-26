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
import type { PrivacyIdentity } from "@lunora/privacy";
import { dispatchPort } from "@lunora/privacy/workflow";
import { createInProcessRuntime, resolveInProcessIdentity } from "@lunora/server/in-process";
import type { WorkflowRunContext } from "@lunora/workflow";
import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { MutationCtx } from "../../lunora/_generated/server.js";
import { privacyConfig, privacyFor, privacyWorkflows } from "../../lunora/privacy";
import { localPorts } from "../../lunora/privacy-ports";
import schema from "../../lunora/schema";
import type { RunHooks } from "../workflow-context";
import { workflowContext } from "../workflow-context";
import { clearSignIn, ensureSignIn, seedSignIn } from "./sign-in";

type Context = WorkflowRunContext<{ requestId: string }>;
type Runtime = ReturnType<typeof createInProcessRuntime>;
type Database = ReturnType<Runtime["createWriters"]>["database"];

const DOWNLOAD_PATH = /^\/privacy\/files\?/u;
const SUBJECT = "u1";
const OTHER = "u2";

const identity = (subjectId: string): PrivacyIdentity => {
    return { sessionAgeMs: 60_000, subjectId };
};

/**
 * The app's mutation context over the shard's writer. The ports read `ctx.db` only; the
 * workflows are started by the test, as the node suite does.
 */
const appCtx = (db: Database): MutationCtx => ({ db }) as unknown as MutationCtx;

/**
 * A workflow context over the shard. `run` does what the internal `privacyPort` mutation does:
 * the package's dispatcher over the app's local ports.
 */
const contextFor = (db: Database, requestId: string, hooks: RunHooks = {}): Context =>
    workflowContext(
        {
            env: { DB: env.DB, PRIVACY_TOMBSTONES: env.PRIVACY_TOMBSTONES },
            params: { requestId },
            run: async (_reference, args) => dispatchPort(privacyConfig, localPorts(appCtx(db)), args.method, args.payload),
        },
        hooks,
    );

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

/** The request's status and the events it recorded, so a run that failed names its code in the assertion. */
const runOf = async (db: Database, requestId: string): Promise<{ events: string[]; status?: string }> => {
    const events = await db.query("privacy_events").collect();

    return {
        events: events.filter((row) => row.requestId === requestId).map((row) => `${String(row.kind)}: ${String(row.detail ?? "")}`),
        status: (await requestRow(db, requestId))?.status,
    };
};

describe("privacy example lifecycle (workerd)", () => {
    beforeEach(async () => {
        await ensureSignIn(env.DB, env.AUTH_SECRET);
        await clearSignIn(env.DB);
    });

    it("exports the subject's rows, stores the archive, and links a download", async () => {
        expect.assertions(6);

        await withShard(async (db) => {
            await seed(db);

            const request = await privacyFor(appCtx(db), identity(SUBJECT)).requestExport();

            await privacyWorkflows.exportHandler(contextFor(db, request.id));

            const rows = await db.query("exportFiles").collect();
            const part = rows.find((row) => row.requestId === request.id && (row.name as string).endsWith("/parts/tasks.json"));
            const stored = JSON.parse((part?.body as string | undefined) ?? "{}") as { tables: { tasks: { title: string }[] } };

            expect(stored.tables.tasks.map((row) => row.title).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["book flights", "renew passport"]);

            const archive = rows.find((row) => row.requestId === request.id && (row.name as string).endsWith("/export.zip"));

            expect(archive?.encoding).toBe("base64");

            const ready = await requestRow(db, request.id);

            expect(ready?.status).toBe("ready");

            await expect(privacyFor(appCtx(db), identity(SUBJECT)).downloadUrl({ requestId: request.id })).resolves.toMatch(DOWNLOAD_PATH);
            await expect(privacyFor(appCtx(db), identity(OTHER)).downloadUrl({ requestId: request.id })).rejects.toMatchObject({
                code: "NOT_FOUND",
            });
            await expect(tasksOf(db, OTHER)).resolves.toStrictEqual(["not yours"]);
        });
    });

    it("erases the subject's rows through the erasure workflow, and only theirs", async () => {
        expect.assertions(4);

        await withShard(async (db) => {
            await seed(db);

            const request = await privacyFor(appCtx(db), identity(SUBJECT)).requestErasure();

            await expect(tasksOf(db, SUBJECT)).resolves.toHaveLength(2);

            await privacyWorkflows.erasureHandler(contextFor(db, request.id));

            await expect(tasksOf(db, SUBJECT)).resolves.toStrictEqual([]);
            await expect(tasksOf(db, OTHER)).resolves.toStrictEqual(["not yours"]);

            const completed = await requestRow(db, request.id);

            expect(completed?.status).toBe("completed");
        });
    });

    it("leaves the rows alone when the subject cancels during the grace", async () => {
        expect.assertions(5);

        await withShard(async (db) => {
            await seed(db);

            const request = await privacyFor(appCtx(db), identity(SUBJECT)).requestErasure();
            const opened = await requestRow(db, request.id);

            expect(opened?.status).toBe("grace");

            // The workflow loads the request while it is still in its grace, and the subject cancels
            // while it sleeps, so the run sleeps the grace out and its start step finds the cancel.
            const steps: string[] = [];

            await privacyWorkflows.erasureHandler(
                contextFor(db, request.id, {
                    duringSleep: async () => {
                        await privacyFor(appCtx(db), identity(SUBJECT)).cancelRequest({ requestId: request.id });
                    },
                    steps,
                }),
            );

            expect(steps).toStrictEqual(["load", "sleep:grace", "start"]);
            await expect(tasksOf(db, SUBJECT)).resolves.toHaveLength(2);
            await expect(tasksOf(db, OTHER)).resolves.toStrictEqual(["not yours"]);

            const cancelled = await requestRow(db, request.id);

            expect(cancelled?.status).toBe("cancelled");
        });
    });

    it("erases a restored subject again, because the tombstones live outside the shard", async () => {
        expect.assertions(4);

        // Erase the subject in the live shard. The workflow writes the tombstone to its own Durable Object.
        await withShard(async (db) => {
            await seed(db);

            const request = await privacyFor(appCtx(db), identity(SUBJECT)).requestErasure();

            await privacyWorkflows.erasureHandler(contextFor(db, request.id));

            await expect(tasksOf(db, SUBJECT)).resolves.toStrictEqual([]);
        });

        // A point-in-time restore brings back the shard as it was before the erasure: a fresh
        // shard with the subject's rows, and none of the live shard's tables. The tombstone store is untouched.
        await withShard(async (db) => {
            await seed(db);

            // The restore workflow the operator's `restorePrivacyErasures` starts, with the ids the restored shard holds.
            const reerased = await privacyWorkflows.restoreHandler(
                workflowContext({
                    env: { DB: env.DB, PRIVACY_TOMBSTONES: env.PRIVACY_TOMBSTONES },
                    params: { restoredSubjectIds: [SUBJECT, OTHER] },
                    run: async (_reference, args) => dispatchPort(privacyConfig, localPorts(appCtx(db)), args.method, args.payload),
                }),
            );

            expect(reerased).toStrictEqual([SUBJECT]);
            await expect(tasksOf(db, SUBJECT)).resolves.toStrictEqual([]);
            await expect(tasksOf(db, OTHER)).resolves.toStrictEqual(["not yours"]);
        });
    });

    it("keeps an invoice under its retention period through erasure, then purges it once the period has ended", async () => {
        expect.assertions(4);

        await withShard(async (db) => {
            await db.insert("invoices", { amount: 4200, issuedAt: Date.now(), number: "INV-1", userId: SUBJECT });

            const request = await privacyFor(appCtx(db), identity(SUBJECT)).requestErasure();

            await privacyWorkflows.erasureHandler(contextFor(db, request.id));

            await expect(db.query("invoices").collect()).resolves.toStrictEqual([]);

            const kept = await db.query("privacy_archive").collect();

            expect(kept.map((row) => row.table)).toStrictEqual(["invoices"]);

            // The period runs for years from the invoice date, so the sweep keeps the row.
            await expect(privacyFor(appCtx(db)).admin.sweep()).resolves.toMatchObject({ purged: 0 });

            // A kept row whose period has ended is purged by the sweep.
            await db.insert("privacy_archive", {
                datasetId: "billing",
                retainUntil: Date.now() - 86_400_000,
                row: "{}",
                subjectId: SUBJECT,
                table: "invoices",
            });

            await expect(privacyFor(appCtx(db)).admin.sweep()).resolves.toMatchObject({ purged: 1 });
        });
    });

    it("expires a finished export past its download window and deletes its files", async () => {
        expect.assertions(4);

        await withShard(async (db) => {
            await seed(db);

            const request = await privacyFor(appCtx(db), identity(SUBJECT)).requestExport();

            await privacyWorkflows.exportHandler(contextFor(db, request.id));

            // The sweep only expires a ready export, so a failed run here is the reason the sweep below finds nothing.
            await expect(runOf(db, request.id)).resolves.toMatchObject({ status: "ready" });

            // The typed mutation context, so the row id keeps its table type for `patch`.
            const ctx = appCtx(db);
            const requests = await ctx.db.query("privacy_requests").collect();
            const row = requests.find((candidate) => candidate.requestId === request.id);

            if (row === undefined) {
                throw new Error(`No privacy request row for ${request.id}.`);
            }

            await ctx.db.patch(row._id, { expiresAt: Date.now() - 1000 });

            const swept = await privacyFor(appCtx(db)).admin.sweep();

            expect(swept.expired.map((expired) => expired.id)).toStrictEqual([request.id]);

            const files = await db.query("exportFiles").collect();

            expect(files.filter((file) => file.requestId === request.id)).toStrictEqual([]);

            await expect(requestRow(db, request.id)).resolves.toMatchObject({ status: "expired" });
        });
    });

    it("exports the subject's sign-in rows without the password hash", async () => {
        expect.assertions(3);

        await withShard(async (db) => {
            await seed(db);
            await seedSignIn(env.DB, SUBJECT);

            const request = await privacyFor(appCtx(db), identity(SUBJECT)).requestExport();

            await privacyWorkflows.exportHandler(contextFor(db, request.id));

            await expect(runOf(db, request.id)).resolves.toMatchObject({ status: "ready" });

            const files = await db.query("exportFiles").collect();
            const part = files.find((row) => row.requestId === request.id && (row.name as string).endsWith("/parts/auth.json"));
            const stored = JSON.parse((part?.body as string | undefined) ?? "{}") as { tables: Record<string, Record<string, unknown>[]> };

            expect(stored.tables.user?.map((row) => row.id)).toStrictEqual([SUBJECT]);
            expect(stored.tables.account?.[0]).not.toHaveProperty("password");
        });
    });

    it("erases the subject's sign-in rows from D1, and leaves the other subject's", async () => {
        expect.assertions(3);

        await withShard(async (db) => {
            await seed(db);
            await seedSignIn(env.DB, SUBJECT);
            await seedSignIn(env.DB, OTHER);

            const request = await privacyFor(appCtx(db), identity(SUBJECT)).requestErasure();

            await privacyWorkflows.erasureHandler(contextFor(db, request.id));

            const users = await env.DB.prepare('SELECT "id" FROM "user" ORDER BY "id"').all<{ id: string }>();
            const sessions = await env.DB.prepare('SELECT "userId" FROM "session" ORDER BY "userId"').all<{ userId: string }>();
            const accounts = await env.DB.prepare('SELECT "userId" FROM "account" ORDER BY "userId"').all<{ userId: string }>();

            expect(users.results.map((row) => row.id)).toStrictEqual([OTHER]);
            expect(sessions.results.map((row) => row.userId)).toStrictEqual([OTHER]);
            expect(accounts.results.map((row) => row.userId)).toStrictEqual([OTHER]);
        });
    });
});
