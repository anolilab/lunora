import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { deferred, makeGeneratedShard, transactionalHost } from "./_helpers/generated-composition";

describe("generated composed mutation transaction ownership", () => {
    it.each([
        { lazyFunctions: true, siblings: false },
        { lazyFunctions: false, siblings: false },
        { lazyFunctions: true, siblings: true },
        { lazyFunctions: false, siblings: true },
    ])("isolates independent transaction outcomes: %j", async ({ lazyFunctions, siblings }) => {
        expect.hasAssertions();

        const root = mkdtempSync(join(tmpdir(), "lunora-composition-transaction-"));
        mkdirSync(join(root, "lunora"));
        const key = `__composition${randomUUID()}`;
        const loaded = deferred();
        const releaseLoad = deferred();
        const blockerEntered = deferred();
        const releaseBlocker = deferred();
        const queued = deferred();
        const database = new DatabaseSync(":memory:");
        database.exec("CREATE TABLE evidence (owner TEXT)");
        const scheduled: string[] = [];
        const deleted: string[] = [];
        const identities: unknown[] = [];
        const fixture: {
            blocker?: Promise<unknown>;
            blockerEntered: ReturnType<typeof deferred>;
            database: DatabaseSync;
            identities: unknown[];
            loaded: ReturnType<typeof deferred>;
            releaseBlocker: ReturnType<typeof deferred>;
            releaseLoad: ReturnType<typeof deferred>;
        } = { loaded, releaseLoad, blockerEntered, releaseBlocker, database, identities };
        Reflect.set(globalThis, key, fixture);
        const stateSource = `const state = globalThis[${JSON.stringify(key)}];\n`;
        writeFileSync(
            join(root, "lunora", "action.ts"),
            `${stateSource}
export const run = { args: {}, kind: "action", handler: async (ctx) => {
    ${lazyFunctions || siblings ? "" : "state.loaded.resolve(); await state.releaseLoad.promise;"}
    ${siblings && !lazyFunctions ? 'state.blocker = ctx.runMutation({ __lunoraRef: "blocker:block" }, {}).catch((error) => error); state.loaded.resolve(); await state.releaseLoad.promise;' : ""}
    const writing = ctx.runMutation({ __lunoraRef: "cold:write" }, {});
    ${siblings && lazyFunctions ? 'state.blocker = ctx.runMutation({ __lunoraRef: "blocker:block" }, {}).catch((error) => error);' : ""}
    return writing;
} };`,
        );
        writeFileSync(
            join(root, "lunora", "cold.ts"),
            `${stateSource}
${lazyFunctions ? "state.loaded.resolve(); await state.releaseLoad.promise;" : ""}
export const write = { args: {}, kind: "mutation", handler: async (ctx) => {
    state.database.exec("INSERT INTO evidence VALUES ('action')");
    state.identities.push(ctx.auth.userId);
    await ctx.scheduler.runAfter(0, "action-job", {});
    ctx.storage.deleteAfterCommit("action-object");
    return "committed";
} };`,
        );
        writeFileSync(
            join(root, "lunora", "blocker.ts"),
            `${stateSource}
export const block = { args: {}, kind: "mutation", handler: async (ctx) => {
    state.database.exec("INSERT INTO evidence VALUES ('blocker')");
    await ctx.scheduler.runAfter(0, "blocker-job", {});
    ctx.storage.deleteAfterCommit("blocker-object");
    state.blockerEntered.resolve();
    await state.releaseBlocker.promise;
    throw new Error("rollback blocker");
} };`,
        );
        let observeQueue = false;
        const host = transactionalHost(database, () => {
            if (observeQueue) {
                queued.resolve();
            }
        });
        try {
            const Shard = await makeGeneratedShard(root, lazyFunctions, {
                scheduler: () => {
                    return {
                        runAfter: async (_when: number, target: string) => {
                            scheduled.push(target);
                            return target;
                        },
                    };
                },
                storage: () => {
                    return {
                        delete: async (object: string) => {
                            deleted.push(object);
                        },
                    };
                },
            });
            const shard = new Shard(host.state, {});
            const request = (functionPath: string, userId: string): Request =>
                new Request("https://shard.internal/rpc", {
                    body: JSON.stringify({ args: {}, functionPath }),
                    headers: { "content-type": "application/json", "x-lunora-userid": userId },
                    method: "POST",
                });
            const action = shard.fetch(request("action:run", "alice"));
            await loaded.promise;
            const blocker = siblings ? undefined : shard.fetch(request("blocker:block", "bob"));
            await blockerEntered.promise;
            observeQueue = true;
            releaseLoad.resolve();
            const first = await Promise.race([
                action.then(
                    () => "action completed",
                    () => "action rejected",
                ),
                queued.promise.then(() => "action queued"),
            ]);
            releaseBlocker.resolve();
            await (blocker ?? fixture.blocker);
            const response = await action;

            expect(response.status).toBe(200);
            expect({ first, rows: database.prepare("SELECT owner FROM evidence").all() }).toEqual({ first: "action queued", rows: [{ owner: "action" }] });
            expect(scheduled).toEqual(["action-job"]);
            expect(deleted).toEqual(["action-object"]);
            expect(identities).toEqual(["alice"]);
        } finally {
            releaseLoad.resolve();
            releaseBlocker.resolve();
            Reflect.deleteProperty(globalThis, key);
            database.close();
            rmSync(root, { force: true, recursive: true });
        }
    });
    it.each([
        { lazyFunctions: true, rollback: false },
        { lazyFunctions: false, rollback: false },
        { lazyFunctions: true, rollback: true },
        { lazyFunctions: false, rollback: true },
    ])("keeps true nested writes in their outer transaction: %j", async ({ lazyFunctions, rollback }) => {
        expect.hasAssertions();

        const root = mkdtempSync(join(tmpdir(), "lunora-nested-transaction-"));
        mkdirSync(join(root, "lunora"));
        const key = `__composition${randomUUID()}`;
        const loaded = deferred();
        const releaseLoad = deferred();
        const database = new DatabaseSync(":memory:");
        database.exec("CREATE TABLE evidence (owner TEXT)");
        const scheduled: string[] = [];
        const deleted: string[] = [];
        Reflect.set(globalThis, key, { loaded, releaseLoad, database });
        const stateSource = `const state = globalThis[${JSON.stringify(key)}];\n`;
        writeFileSync(
            join(root, "lunora", "action.ts"),
            `${stateSource}
export const run = { args: {}, kind: "mutation", handler: async (ctx) => {
    state.database.exec("INSERT INTO evidence VALUES ('outer')");
    await ctx.runMutation({ __lunoraRef: "cold:write" }, {});
    ${rollback ? 'throw new Error("outer rollback");' : 'return "committed";'}
} };`,
        );
        writeFileSync(
            join(root, "lunora", "cold.ts"),
            `${stateSource}
${lazyFunctions ? "state.loaded.resolve(); await state.releaseLoad.promise;" : ""}
export const write = { args: {}, kind: "mutation", handler: async (ctx) => {
    state.database.exec("INSERT INTO evidence VALUES ('nested')");
    await ctx.scheduler.runAfter(0, "nested-job", {});
    ctx.storage.deleteAfterCommit("nested-object");
} };`,
        );
        writeFileSync(join(root, "lunora", "blocker.ts"), 'export const block = { args: {}, kind: "mutation", handler: () => null };');
        try {
            const Shard = await makeGeneratedShard(
                root,
                lazyFunctions,
                {
                    scheduler: () => {
                        return {
                            runAfter: async (_when: number, target: string) => {
                                scheduled.push(target);
                                return target;
                            },
                        };
                    },
                    storage: () => {
                        return {
                            delete: async (object: string) => {
                                deleted.push(object);
                            },
                        };
                    },
                },
                "mutation",
            );
            const host = transactionalHost(database);
            const shard = new Shard(host.state, {});
            const outcome = shard.handleRpc("action:run", {}).catch((error: unknown) => error);
            if (lazyFunctions) {
                await loaded.promise;
            }
            releaseLoad.resolve();
            const result = await outcome;

            expect(result instanceof Error).toBe(rollback);
            expect(host.transactionCount()).toBe(1);
            expect(database.prepare("SELECT owner FROM evidence").all()).toEqual(rollback ? [] : [{ owner: "outer" }, { owner: "nested" }]);
            expect(scheduled).toEqual(rollback ? [] : ["nested-job"]);
            expect(deleted).toEqual(rollback ? [] : ["nested-object"]);
        } finally {
            releaseLoad.resolve();
            Reflect.deleteProperty(globalThis, key);
            database.close();
            rmSync(root, { force: true, recursive: true });
        }
    });
});
