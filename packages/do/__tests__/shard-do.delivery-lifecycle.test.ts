import { serialize } from "node:v8";

import { LunoraError } from "@lunora/errors";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupDatabases, dataFrames, gate, permit, setup, TestShard } from "./_helpers/delivery-authorization";

const errors = (test: ReturnType<typeof setup>) => test.socket.frames.filter((frame) => frame.type === "error");

describe("delivery authorization lifecycle", () => {
    afterEach(cleanupDatabases);

    it("retains feature-off subscriptions when a handler throws the persistence error code", async () => {
        expect.hasAssertions();

        const test = setup();
        const unguarded = new TestShard(test.state, {});
        const write = () =>
            unguarded.fetch(
                new Request("https://shard.internal/rpc", {
                    method: "POST",
                    body: JSON.stringify({ functionPath: "messages:write", args: {} }),
                }),
            );

        await test.send(unguarded);

        unguarded.queryFailure = new LunoraError("SUBSCRIPTION_PERSIST_FAILED", "user handler failure");
        await write();

        expect(test.socket.attachment.subs.view).toBeDefined();
        // Told once, as a handler failure: the colliding code is the handler's own, so it is neither
        // mistaken for the framework's persistence refusal (the subscription stays registered) nor repeated.
        expect(errors(test)).toHaveLength(1);

        unguarded.queryFailure = undefined;
        unguarded.rows = ["recovered"];
        await write();

        expect(dataFrames(test.socket).at(-1)?.data).toEqual(["recovered"]);
    });

    it.each(["BAD_REQUEST", "NOT_FOUND", "UNAUTHORIZED"])("preserves a seed handler's %s error", async (code) => {
        expect.hasAssertions();

        const test = setup();

        test.shard.queryFailure = new LunoraError(code, "query refused");

        await test.send();

        expect(errors(test).at(-1)).toMatchObject({ error: { code, message: "query refused" } });
        expect(dataFrames(test.socket)).toEqual([]);
    });

    it("keeps the delivered view when the authority or refresh handler is unavailable", async () => {
        expect.hasAssertions();

        const test = setup();

        await test.send();

        test.authority.mockImplementation(async (request) => {
            if (request.transport === "subscription") {
                throw new Error("authority unavailable");
            }
            return permit(0);
        });

        await test.write();

        expect(errors(test)).toEqual([]);
        expect(test.socket.attachment.subs.view).toBeDefined();

        test.authority.mockResolvedValue(permit(0));

        test.shard.queryFailure = new Error("handler unavailable");

        await test.write();

        expect(errors(test)).toEqual([]);
        expect(dataFrames(test.socket)).toHaveLength(1);
    });

    it("removes a denied subscription once and re-seeds unchanged rows after a re-grant", async () => {
        expect.hasAssertions();

        const test = setup();

        await test.send();

        test.revoke();

        await test.fence();

        expect(test.socket.attachment.subs).toEqual({});
        expect(test.socket.attachment.deliveryPermits).toEqual({});
        expect(errors(test)).toHaveLength(1);

        test.regrant();

        await test.write();

        expect(errors(test)).toHaveLength(1);

        await test.send();

        expect(dataFrames(test.socket).map((frame) => frame.type)).toEqual(["data", "data"]);
        expect(dataFrames(test.socket).at(-1)?.data).toEqual(["before"]);
    });

    it("does not revoke a pending authorization for an unrelated scope", async () => {
        expect.hasAssertions();

        const test = setup();
        const started = gate();
        const release = gate();

        test.authority.mockImplementation(async () => {
            started.resolve();
            await release.promise;
            return { scope: "unrelated", epoch: 0 };
        });

        const seed = test.send();
        await started.promise;

        await test.fence();

        expect(errors(test)).toEqual([]);

        release.resolve();
        await seed;

        expect(dataFrames(test.socket)).toHaveLength(1);
    });

    it("does not restore a marker or run the query after unsubscribe during authorization", async () => {
        expect.hasAssertions();

        const test = setup();
        const started = gate();
        const release = gate();

        test.authority.mockImplementation(async () => {
            started.resolve();
            await release.promise;
            return permit(0);
        });

        const seed = test.send();
        await started.promise;

        await test.shard.webSocketMessage(test.socket as unknown as WebSocket, JSON.stringify({ type: "unsubscribe", id: "view" }));

        const { saves } = test.socket;
        release.resolve();
        await seed;

        expect(test.shard.queryCalls).toBe(0);
        expect(test.socket.attachment.subs).toEqual({});
        expect(test.socket.attachment.deliveryPermits).toBeUndefined();
        expect(test.socket.saves).toBe(saves);
        expect(errors(test)).toEqual([]);
    });

    it("does not stamp a superseded authorization onto a replacement subscription", async () => {
        expect.hasAssertions();

        const test = setup();
        const started = gate();
        const release = gate();

        test.authority.mockImplementation(async ({ functionPath }) => {
            if (functionPath === "messages:list") {
                started.resolve();
                await release.promise;
                return permit(0);
            }
            return { scope: "replacement", epoch: 0 };
        });

        const previous = test.send();
        await started.promise;

        await test.shard.webSocketMessage(
            test.socket as unknown as WebSocket,
            JSON.stringify({
                type: "subscribe",
                id: "view",
                query: { functionPath: "messages:other", args: {} },
            }),
        );

        release.resolve();
        await previous;

        expect(test.socket.attachment.deliveryPermits).toEqual({ view: { scope: "replacement", epoch: 0 } });
        expect(test.shard.queryCalls).toBe(1);
        expect(errors(test)).toEqual([]);
    });

    it("drops an in-flight query after the same subscription id is replaced", async () => {
        expect.hasAssertions();

        const test = setup();
        const release = gate();

        test.shard.queryGate = release.promise;

        const previous = test.send();

        await test.shard.queryStarted.promise;

        test.shard.queryGate = undefined;

        test.shard.rows = ["replacement"];

        await test.send();

        release.resolve();
        await previous;

        expect(dataFrames(test.socket).map((frame) => frame.data)).toEqual([["replacement"]]);
        expect(errors(test)).toEqual([]);
    });

    it("retains one unchanged persisted marker across refreshes", async () => {
        expect.hasAssertions();

        const test = setup();

        await test.send();

        const { saves } = test.socket;
        const clone = test.socket.deserializeAttachment();
        delete clone.deliveryPermits?.view;

        expect(test.socket.deserializeAttachment().deliveryPermits).toEqual({ view: permit(0) });

        await test.write();

        expect(test.socket.attachment.deliveryPermits).toEqual({ view: permit(0) });
        expect(test.socket.saves).toBe(saves);
    });

    it("unsubscribes and reports a refresh permit that no longer fits the attachment", async () => {
        expect.hasAssertions();

        const test = setup();

        await test.send();

        test.socket.attachmentLimit = serialize(test.socket.attachment).byteLength;

        test.authority.mockResolvedValue({ scope: "larger-authority-scope".repeat(8), epoch: 1 });

        await test.write();

        expect(errors(test).at(-1)).toMatchObject({ error: { code: "SUBSCRIPTION_PERSIST_FAILED" } });
        expect(test.socket.attachment.subs).toEqual({});

        const { length: attempts } = test.authority.mock.calls;

        await test.write();

        expect(test.authority).toHaveBeenCalledTimes(attempts + 1);
        expect(errors(test)).toHaveLength(1);
    });

    it("rolls back a permit that exceeds the complete structured-clone attachment budget", async () => {
        expect.hasAssertions();

        const test = setup();
        const started = gate();
        const release = gate();

        test.authority.mockImplementation(async () => {
            started.resolve();
            await release.promise;
            return permit(0);
        });

        const seed = test.send();
        await started.promise;

        test.socket.attachmentLimit = serialize(test.socket.attachment).byteLength;

        release.resolve();
        await seed;

        expect(errors(test).at(-1)).toMatchObject({ error: { code: "SUBSCRIPTION_PERSIST_FAILED" } });
        expect(test.socket.attachment.deliveryPermits).toBeUndefined();
        expect(test.socket.attachment.subs).toEqual({});
        expect(test.shard.queryCalls).toBe(0);
    });
});
