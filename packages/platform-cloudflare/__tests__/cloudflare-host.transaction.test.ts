import { LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import { createShardHost } from "../src/cloudflare-host";

/**
 * Error identity across the durable-transaction boundary.
 *
 * workerd rolls a failed `storage.transaction` back correctly, but the exception
 * it propagates back out is a FLATTENED copy: a plain `Error` whose message is
 * the original's `name: message`, carrying none of its own properties. Since
 * `isLunoraError` is structural (`type` + `code` + `status`), every coded error a
 * mutation handler threw failed that check on the way out and was rendered to the
 * client as a generic 500 `INTERNAL` / "Internal error" — a `NOT_FOUND`, a
 * `CONFLICT` on a unique index, an `UNAUTHENTICATED` guard, all identical and all
 * logged as internal faults. Queries never enter a transaction, so they were
 * unaffected, which is what made the behaviour look arbitrary.
 *
 * These tests pin the two halves that have to stay true together: the closure's
 * throw still reaches the platform (so the rollback happens), and the caller
 * still receives the *original* error object.
 */

/** A `storage` double that flattens a thrown error exactly the way workerd does. */
const flatteningStorage = (): { calls: string[]; transaction: <R>(closure: () => Promise<R>) => Promise<R> } => {
    const calls: string[] = [];

    return {
        calls,
        transaction: async <R>(closure: () => Promise<R>): Promise<R> => {
            try {
                const value = await closure();

                calls.push("committed");

                return value;
            } catch (error) {
                calls.push("rolled-back");

                // The lossy re-throw this fix exists to survive: workerd keeps
                // only the stringified form. `cause` is carried for the lint
                // rule's benefit — the point of the double is that `code` /
                // `status` do NOT survive.
                throw new Error(String(error), { cause: error });
            }
        },
    };
};

const hostWith = (storage: unknown) => createShardHost({ storage } as never);

/**
 * A `blockConcurrencyWhile` double that mirrors workerd's behaviour: a closure
 * that REJECTS aborts the object. The double records that abort so a regression
 * is visible rather than merely slower.
 */
const gate = (): { aborted: boolean; blockConcurrencyWhile: <R>(closure: () => Promise<R>) => Promise<R> } => {
    const record = {
        aborted: false,
        blockConcurrencyWhile: async <R>(closure: () => Promise<R>): Promise<R> => {
            try {
                return await closure();
            } catch (error) {
                record.aborted = true;

                throw new Error(String(error), { cause: error });
            }
        },
    };

    return record;
};

describe("cloudflare shard host transaction", () => {
    it("rethrows the handler's own error instance, not the platform's flattened copy", async () => {
        expect.assertions(4);

        const storage = flatteningStorage();
        const thrown = new LunoraError("NOT_FOUND", "lobby not found");

        await expect(hostWith(storage).transaction(() => Promise.reject(thrown))).rejects.toBe(thrown);

        // Same object, so the wire-relevant fields the error renderer keys on survive.
        await expect(hostWith(storage).transaction(() => Promise.reject(thrown))).rejects.toMatchObject({
            code: "NOT_FOUND",
            status: 404,
        });

        expect(storage.calls).toStrictEqual(["rolled-back", "rolled-back"]);
        // The closure must still throw INTO the platform, or nothing rolls back.
        expect(storage.calls).not.toContain("committed");
    });

    it("still surfaces a platform-side failure that the closure never raised", async () => {
        expect.assertions(1);

        // A commit/rollback fault belongs to the platform: there is no handler
        // error to restore, so it must not be swallowed or replaced.
        const storage = {
            transaction: async <R>(closure: () => Promise<R>): Promise<R> => {
                await closure();

                throw new Error("commit failed");
            },
        };

        await expect(hostWith(storage).transaction(() => Promise.resolve("ok"))).rejects.toThrow("commit failed");
    });

    it("passes a successful result through untouched", async () => {
        expect.assertions(2);

        const storage = flatteningStorage();

        await expect(hostWith(storage).transaction(() => Promise.resolve({ moved: 1 }))).resolves.toStrictEqual({ moved: 1 });
        expect(storage.calls).toStrictEqual(["committed"]);
    });

    it("preserves a thrown `undefined` rather than reporting the flattened error", async () => {
        expect.assertions(1);

        // The saved throw is boxed, so "the closure threw undefined" stays
        // distinguishable from "the closure never threw". Thrown from the body
        // rather than `Promise.reject(undefined)` so the non-Error rejection is
        // expressed the way a handler would actually produce it.
        const throwsUndefined = async (): Promise<never> => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately non-Error: surviving a non-Error throw is what this asserts
            throw undefined;
        };

        await expect(hostWith(flatteningStorage()).transaction(throwsUndefined)).rejects.toBeUndefined();
    });

    it("runs bare when the storage double has no transaction support", async () => {
        expect.assertions(1);

        await expect(hostWith({}).transaction(() => Promise.resolve("bare"))).resolves.toBe("bare");
    });

    it("does not abort the Durable Object when a handler throws", async () => {
        expect.assertions(3);

        // workerd tears the object down when a `blockConcurrencyWhile` closure
        // rejects — taking its in-memory state and every hibernating WebSocket
        // subscription with it. An ordinary application error must not cost the
        // shard its object, nor every other client connected to it.
        const state = gate();
        const host = createShardHost({ ...state, storage: {} } as never);
        const thrown = new LunoraError("CONFLICT", "not your turn");

        await expect(host.runSerialized(() => Promise.reject(thrown))).rejects.toBe(thrown);

        expect(state.aborted).toBe(false);
        // And the gate still serializes the success path.
        await expect(host.runSerialized(() => Promise.resolve(7))).resolves.toBe(7);
    });

    it("keeps the coded error intact through the full mutation path (gate + transaction)", async () => {
        expect.assertions(2);

        // `runInTransaction` composes both boundaries, and both flatten. This is
        // the shape a real mutation error travels through.
        const state = gate();
        const storage = flatteningStorage();
        const host = createShardHost({ ...state, storage } as never);
        const thrown = new LunoraError("NOT_FOUND", "lobby not found");

        await expect(host.runSerialized(async () => host.transaction(() => Promise.reject(thrown)))).rejects.toMatchObject({
            code: "NOT_FOUND",
            status: 404,
        });

        expect(storage.calls).toStrictEqual(["rolled-back"]);
    });
});
