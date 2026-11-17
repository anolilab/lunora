import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { deferred, makeGeneratedShard, transactionalHost } from "./_helpers/generated-composition";

interface ScopeSnapshot {
    baselineSeq?: number;
    bookmark?: string;
    clientId?: string;
    clientSeq?: number;
    ip?: string;
    mutationId?: string;
    origin?: string;
    traceparent?: string;
    userId?: string;
}

const request = (functionPath: string, owner: "alice" | "bob"): Request =>
    new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args: {}, functionPath }),
        headers: {
            "content-type": "application/json",
            "x-d1-bookmark": `${owner}-bookmark`,
            "x-lunora-base-seq": owner === "alice" ? "7" : "19",
            "x-lunora-client-id": `${owner}-client`,
            "x-lunora-client-ip": owner === "alice" ? "192.0.2.1" : "192.0.2.2",
            "x-lunora-client-seq": owner === "alice" ? "2" : "5",
            ...(owner === "alice" ? { "x-lunora-mutation-id": "alice-mutation" } : {}),
            "x-lunora-origin": `https://${owner}.example`,
            "x-lunora-userid": owner,
            traceparent:
                owner === "alice" ? "00-11111111111111111111111111111111-1111111111111111-01" : "00-22222222222222222222222222222222-2222222222222222-01",
        },
        method: "POST",
    });

describe("composed cold module request scope", () => {
    it.each([
        { kind: "query", throws: false, waitingWriter: false },
        { kind: "query", throws: true, waitingWriter: false },
        { kind: "action", throws: false, waitingWriter: false },
        { kind: "action", throws: true, waitingWriter: false },
        { kind: "mutation", throws: false, waitingWriter: false },
        { kind: "mutation", throws: true, waitingWriter: false },
        { kind: "mutation", throws: false, waitingWriter: true },
    ] as const)("restores the caller across composition: %j", async ({ kind, throws, waitingWriter }) => {
        expect.hasAssertions();

        const root = mkdtempSync(join(tmpdir(), "lunora-composition-scope-"));
        mkdirSync(join(root, "lunora"));
        const database = new DatabaseSync(":memory:");
        const key = `__scope${randomUUID()}`;
        const loaded = deferred();
        const release = deferred();
        const siblingEntered = deferred();
        const releaseSibling = deferred();
        const queued = deferred();
        const fixture = {
            loaded,
            release,
            siblingEntered,
            releaseSibling,
            warm: false,
            events: [] as string[],
            inspect: (): ScopeSnapshot => {
                return {};
            },
        };
        Reflect.set(globalThis, key, fixture);
        const stateSource = `const state = globalThis[${JSON.stringify(key)}];\n`;
        writeFileSync(
            join(root, "lunora", "action.ts"),
            `${stateSource}
export const run = { args: {}, kind: "action", handler: async (ctx) => {
    if (state.warm) {
        state.events = [];
        const pending = ctx.run${kind[0]!.toUpperCase()}${kind.slice(1)}({ __lunoraRef: "cold:write" }, {});
        state.events.push("returned");
        await pending;
        return state.events;
    }
    const before = state.inspect();
    try {
        const result = await ctx.run${kind[0]!.toUpperCase()}${kind.slice(1)}({ __lunoraRef: "cold:write" }, {});
        return { before, result };
    } catch (error) {
        return { before, result: state.inspect(), error: error.message };
    }
} };`,
        );
        writeFileSync(
            join(root, "lunora", "cold.ts"),
            `${stateSource}
state.loaded.resolve();
await state.release.promise;
${throws ? 'throw new Error("load failed");' : ""}
export const write = { args: {}, kind: "${kind}", handler: () => { state.events.push("handler"); return state.inspect(); } };`,
        );
        writeFileSync(
            join(root, "lunora", "blocker.ts"),
            `${stateSource}
export const block = { args: {}, kind: "mutation", handler: async () => {
    ${waitingWriter ? "state.siblingEntered.resolve(); await state.releaseSibling.promise;" : ""}
    return state.inspect();
} };`,
        );
        try {
            const Shard = await makeGeneratedShard(root, true, {}, "action", kind);
            let observeQueue = false;
            const shard = new Shard(
                transactionalHost(database, () => {
                    if (observeQueue) {
                        queued.resolve();
                    }
                }).state,
                {},
            );
            const capture = Reflect.get(shard, "captureRequestScope") as () => ScopeSnapshot;
            fixture.inspect = () => {
                const scope = capture.call(shard);
                return {
                    baselineSeq: scope.baselineSeq,
                    bookmark: scope.bookmark,
                    clientId: scope.clientId,
                    clientSeq: scope.clientSeq,
                    ip: scope.ip,
                    mutationId: scope.mutationId,
                    origin: scope.origin,
                    traceparent: scope.traceparent,
                    userId: scope.userId,
                };
            };
            const pending = shard.fetch(request("action:run", "alice"));
            await loaded.promise;
            const sibling = shard.fetch(request("blocker:block", "bob"));
            if (waitingWriter) {
                await siblingEntered.promise;
                observeQueue = true;
                release.resolve();
                await queued.promise;
                releaseSibling.resolve();
            } else {
                await sibling;

                release.resolve();
            }
            const response = await pending;
            const body = (await response.json()) as { result: { before: ScopeSnapshot; error?: string; result: ScopeSnapshot } };

            expect(response.status).toBe(200);
            expect(body.result.before).toMatchObject({ baselineSeq: 7, bookmark: "alice-bookmark", mutationId: "alice-mutation", userId: "alice" });
            expect(body.result.result).toEqual(body.result.before);
            expect(body.result.error).toBe(throws ? "load failed" : undefined);

            const siblingResponse = await sibling;

            expect(siblingResponse.status).toBe(200);

            let warmResult: unknown;
            if (!throws && kind !== "mutation") {
                fixture.warm = true;
                const warmRequest = request("action:run", "alice");
                warmRequest.headers.set("x-lunora-mutation-id", "alice-warm");
                const warmResponse = await shard.fetch(warmRequest);

                warmResult = await warmResponse.json();
            }

            expect(warmResult).toEqual(!throws && kind !== "mutation" ? { result: ["handler", "returned"] } : undefined);
        } finally {
            release.resolve();
            releaseSibling.resolve();
            Reflect.deleteProperty(globalThis, key);
            database.close();
            rmSync(root, { force: true, recursive: true });
        }
    });
});
